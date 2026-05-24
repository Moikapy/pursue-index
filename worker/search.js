// /api/search — vector search via Cloudflare Vectorize + keyword fallback.
//
// Primary: Vectorize semantic search (nomic-embed-text embeddings in pursue-embeddings index)
// Fallback: Keyword search against pages.json if Vectorize unavailable or no results
// Literal card ID detection: hex string lookups bypass search entirely
//
// No external API calls. Embeddings are pre-computed via Ollama on the Pi
// and uploaded to Vectorize. Query-time embedding uses Cloudflare Workers AI
// (bge-small-en-v1.5) — free tier, built-in to the platform.
//
// pages.json format: [{ "id": "cardid-pN", "card_id": "...", "page": N, "title": "...", "text": "..." }]

export const LITERAL_CARD_ID_RE = /\b[a-f0-9]{16}\b/gi;
const DEFAULT_K = 8;

/**
 * Extract 16-hex card_ids from a free-form query.
 */
export function extractLiteralCardIds(query) {
  if (typeof query !== "string" || !query) return [];
  const seen = new Set();
  const out = [];
  for (const match of query.matchAll(LITERAL_CARD_ID_RE)) {
    const id = match[0].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Keyword search fallback. Matches query terms against title (2x) and text.
 */
function keywordSearch(query, pagesArray, topK = DEFAULT_K) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length === 0) return [];

  const results = [];
  for (const page of pagesArray) {
    const title = (page.title || "").toLowerCase();
    const text = (page.text || "").toLowerCase();

    let score = 0;
    for (const term of queryTerms) {
      if (title.includes(term)) score += 2.0;
      if (text.includes(term)) {
        score += 1.0;
        const count = (text.match(new RegExp(term, "g")) || []).length;
        if (count > 1) score += Math.min(0.5, count * 0.1);
      }
    }

    if (score >= 1.5) {
      results.push({
        card_id: page.card_id,
        page: page.page,
        title: page.title || "Untitled",
        snippet: (page.text || "").substring(0, 600),
        score: score / (queryTerms.length * 3),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Literal card ID lookup.
 */
function literalIdPassages(ids, pagesArray, topK) {
  const out = [];
  const seen = new Set();
  const idSet = new Set(ids);

  for (const page of pagesArray) {
    if (idSet.has(page.card_id)) {
      const key = `${page.card_id}-p${page.page}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          card_id: page.card_id,
          page: page.page,
          title: page.title || "Untitled",
          snippet: (page.text || "").substring(0, 600),
          score: 1.0,
        });
      }
    }
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Cache pages.json across requests.
 */
let pagesCache = null;

async function loadPages(env) {
  if (pagesCache) return pagesCache;
  try {
    const res = await env.ASSETS.fetch("https://assets/data/pages.json");
    if (res.ok) {
      pagesCache = await res.json();
      return pagesCache;
    }
  } catch { /* cold start miss */ }
  return [];
}

/**
 * Vector search via Cloudflare Vectorize.
 * Uses Workers AI (@cf/baai/bge-small-en-v1.5) to embed the query,
 * then queries the Vectorize index for top-K matches.
 * Falls back to keyword search if Vectorize unavailable.
 */
async function vectorSearch(query, env, topK = DEFAULT_K) {
  if (!env.VECTORIZE) {
    return null; // Vectorize not bound — fall through to keyword
  }

  try {
    // Use Workers AI qwen3-embedding-0.6b (free tier: $0.012/M tokens)
    const aiResponse = await env.AI.run("@cf/qwen/qwen3-embedding-0.6b", {
      text: [query],
    });

    const queryVector = aiResponse?.data?.[0];
    if (!queryVector || !queryVector.length) {
      return null;
    }

    // Query Vectorize index
    const results = await env.VECTORIZE.query(queryVector, {
      topK,
      returnMetadata: "all",
    });

    if (!results.matches || results.matches.length === 0) {
      return null;
    }

    // Load pages for snippets
    const pagesArray = await loadPages(env);
    const pagesMap = new Map(pagesArray.map(p => [p.id, p]));

    return results.matches.map(match => {
      const page = pagesMap.get(match.id) || {};
      return {
        card_id: page.card_id || match.metadata?.card_id || "",
        page: page.page || match.metadata?.page || 0,
        title: page.title || match.metadata?.title || "Untitled",
        snippet: (page.text || "").substring(0, 600),
        score: match.score,
      };
    });
  } catch (e) {
    // Vectorize/Workers AI not available — fall through
    console.error("Vectorize search error:", e.message || e);
    return null;
  }
}

/**
 * Handle /api/search requests.
 *
 * POST body: { "query": "UAP formation Iran", "limit": 8 }
 * GET params: ?q=UAP+formation+Iran&limit=8
 */
export async function handleSearch(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let query, limit;

  if (request.method === "POST") {
    try {
      const body = await request.json();
      query = body.query || "";
      limit = body.limit || DEFAULT_K;
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    const url = new URL(request.url);
    query = url.searchParams.get("q") || "";
    limit = parseInt(url.searchParams.get("limit") || DEFAULT_K, 10);
  }

  if (!query.trim()) {
    return new Response(JSON.stringify({ error: "query is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Literal card ID lookup
  const literalIds = extractLiteralCardIds(query);
  if (literalIds.length > 0) {
    const pagesArray = await loadPages(env);
    const literal = literalIdPassages(literalIds, pagesArray, limit);
    if (literal.length > 0) {
      return new Response(
        JSON.stringify({ passages: literal, mode: "literal" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // 2. Vector search (primary)
  const vectorResults = await vectorSearch(query, env, limit);
  if (vectorResults && vectorResults.length > 0) {
    return new Response(
      JSON.stringify({ passages: vectorResults, mode: "vector", query }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Keyword search (fallback)
  const pagesArray = await loadPages(env);
  const passages = keywordSearch(query, pagesArray, limit);

  return new Response(
    JSON.stringify({ passages, mode: "keyword", query }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// Backward compat
export async function handleRetrieve(request, env) {
  return handleSearch(request, env);
}