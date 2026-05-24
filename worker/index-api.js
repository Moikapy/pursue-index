// pursue-api Worker — API-only entry point for Moikapy.
//
// Stripped-down version of worker/index.js that only handles:
//   /api/retrieve   — semantic search (Voyage embeddings)
//   /api/chat        — Anthropic Q&A
//   /api/tranche-status — our custom endpoint (page/card counts from manifest)
//   /pdf/<id>.pdf    — R2 PDF serving
//   /video/<id>.mp4  — R2 video serving
//   /archive/<sha>   — preserved bytes
//
// No frontend, no CORS gate on API origins, no static asset cache policy,
// no card alias redirects, no security headers for browser pages.
// Pure data API for our tools.

import { handleRetrieve } from "./retrieve.js";
import { handleChat } from "./chat.js";
import { tryHandlePdfRoute, tryHandleVideoRoute, tryHandleArchiveRoute } from "./pdf.js";

// Our API paths — no frontend, no /api docs page
const API_PATHS = new Set(["/api/retrieve", "/api/chat", "/api/tranche-status"]);

// No CORS restriction — our tools call from Pi cron, CLI, dashboard.
// Set permissive CORS for our own subdomain use.
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

// Minimal security headers for API-only
const SECURITY_HEADERS = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

function withHeaders(response) {
  const next = new Response(response.body, response);
  for (const [name, value] of SECURITY_HEADERS) {
    if (!next.headers.has(name)) next.headers.set(name, value);
  }
  return next;
}

/**
 * /api/tranche-status — custom Moikapy endpoint.
 *
 * Returns corpus stats from the static assets (manifest + pages data).
 * Used by our 30-min cron poll instead of scraping the homepage.
 */
async function handleTrancheStatus(request, env) {
  // Try to get card count from the asset listing
  let cardCount = 0;
  let pageCount = 0;

  try {
    // embed_index.json: { model_id, dim, n: 4127, pages: [[card_id, page_num], ...] }
    const indexRes = await env.ASSETS.fetch("https://assets/data/embed_index.json");
    if (indexRes.ok) {
      const indexData = await indexRes.json();
      pageCount = indexData.n || 0;
      const cards = new Set((indexData.pages || []).map(e => e[0]));
      cardCount = cards.size;
    }
  } catch {
    // Fail soft — return what we have
  }

  return new Response(
    JSON.stringify({
      cards: cardCount,
      pages: pageCount,
      timestamp: new Date().toISOString(),
      source: "moikapy-pursue-api",
    }, null, 2),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800", // match our 30-min poll
        ...corsHeaders(),
      },
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API routes
    if (API_PATHS.has(path)) {
      // Handle preflight
      if (request.method === "OPTIONS") {
        return withHeaders(
          new Response(null, { status: 204, headers: corsHeaders() })
        );
      }

      let response;
      switch (path) {
        case "/api/retrieve":
          response = await handleRetrieve(request, env);
          break;
        case "/api/chat":
          response = await handleChat(request, env);
          break;
        case "/api/tranche-status":
          response = await handleTrancheStatus(request, env);
          break;
        default:
          response = new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
      }

      // Stamp CORS headers on all API responses
      const corsResponse = new Response(response.body, response);
      for (const [k, v] of Object.entries(corsHeaders())) {
        corsResponse.headers.set(k, v);
      }
      return withHeaders(corsResponse);
    }

    // R2 routes — PDFs, videos, archives
    const pdfResponse = await tryHandlePdfRoute(request, env);
    if (pdfResponse) return withHeaders(pdfResponse);

    const videoResponse = await tryHandleVideoRoute(request, env);
    if (videoResponse) return withHeaders(videoResponse);

    const archiveResponse = await tryHandleArchiveRoute(request, env);
    if (archiveResponse) return withHeaders(archiveResponse);

    // Anything else — 404. No frontend to fall through to.
    return withHeaders(
      new Response(
        JSON.stringify({ error: "not found", hint: "API endpoints: /api/retrieve, /api/chat, /api/tranche-status" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );
  },
};