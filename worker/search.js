// /api/search — text-based search against pages.json.
//
// No external API calls, no embeddings, no Voyage, no Anthropic.
// Pure keyword search using page titles and text content.
// Suitable for our use case: poll integration, kapy-research briefs.
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
 * Simple keyword scoring against pages array.
 * Matches query terms against title (2x weight) and text.
 * Returns scored passages sorted by relevance.
 */
function textSearch(query, pagesArray, topK = DEFAULT_K) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (queryTerms.length === 0) return [];

  const results = [];

  for (const page of pagesArray) {
    const title = (page.title || "").toLowerCase();
    const text = (page.text || "").toLowerCase();

    let score = 0;

    for (const term of queryTerms) {
      const inTitle = title.includes(term);
      const inText = text.includes(term);

      if (inTitle) {
        score += 2.0;
      }
      if (inText) {
        score += 1.0;
        // Bonus for multiple occurrences
        const count = (text.match(new RegExp(term, "g")) || []).length;
        if (count > 1) score += Math.min(0.5, count * 0.1);
      }
    }

    // Require at least one title match or two text hits
    if (score >= 1.5) {
      results.push({
        card_id: page.card_id,
        page: page.page,
        title: page.title || "Untitled",
        snippet: (page.text || "").substring(0, 600),
        score: score / (queryTerms.length * 3), // normalize to ~0-1 range
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

/**
 * Look up literal card IDs in the pages array.
 */
function literalIdPassages(ids, pagesArray, topK) {
  const out = [];
  const seen = new Set();

  for (const page of pagesArray) {
    if (ids.includes(page.card_id)) {
      const key = `${page.card_id}-p${page.page}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({
          card_id: page.card_id,
          page: page.page,
          title: page.title || "Untitled",
          snippet: (page.text || "").substring(0, 600),
          score: 1.0, // exact match sentinel
        });
      }
    }
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Cache pages.json across requests (Worker stays warm).
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
  } catch {
    // Cold start fetch failed
  }
  return [];
}

/**
 * Handle /api/search requests.
 *
 * POST body: { "query": "UAP formation Iran", "limit": 8 }
 * GET params: ?q=UAP+formation+Iran&limit=8
 *
 * Also handles literal card ID lookups (e.g., "13f86e95aed52840").
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

  const pagesArray = await loadPages(env);

  // Check for literal card ID matches first
  const literalIds = extractLiteralCardIds(query);
  if (literalIds.length > 0) {
    const literal = literalIdPassages(literalIds, pagesArray, limit);
    if (literal.length > 0) {
      return new Response(
        JSON.stringify({ passages: literal, mode: "literal" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Text search
  const passages = textSearch(query, pagesArray, limit);

  return new Response(
    JSON.stringify({ passages, mode: "text", query }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// Backward compat — same handler
export async function handleRetrieve(request, env) {
  return handleSearch(request, env);
}