// pursue-api Worker — API-only entry point for Moikapy.
//
// Data-only: search, tranche status, file serving. No chat, no external APIs.
// Endpoints:
//   /api/retrieve       — keyword search (backward compat)
//   /api/search          — keyword search (preferred)
//   /api/tranche-status  — corpus stats for poll script
//   /pdf/<id>.pdf        — R2 PDF serving (pending R2 activation)
//   /video/<id>.mp4      — R2 video serving (pending R2 activation)
//   /archive/<sha>       — preserved bytes (pending R2 activation)
//
// Zero external dependencies. No Voyage, no Anthropic, no tracking.

import { handleSearch } from "./search.js";
import { tryHandlePdfRoute, tryHandleVideoRoute, tryHandleArchiveRoute } from "./pdf.js";

const API_PATHS = new Set(["/api/retrieve", "/api/search", "/api/tranche-status"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

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
 * Returns corpus stats from the static assets.
 * Used by our 30-min cron poll instead of scraping the homepage.
 */
async function handleTrancheStatus(request, env) {
  let cardCount = 0;
  let pageCount = 0;

  try {
    const indexRes = await env.ASSETS.fetch("https://assets/data/embed_index.json");
    if (indexRes.ok) {
      const indexData = await indexRes.json();
      pageCount = indexData.n || 0;
      const cards = new Set((indexData.pages || []).map(e => e[0]));
      cardCount = cards.size;
    }
  } catch {
    // Fail soft
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
        "Cache-Control": "public, max-age=1800",
        ...corsHeaders(),
      },
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (API_PATHS.has(path)) {
      if (request.method === "OPTIONS") {
        return withHeaders(
          new Response(null, { status: 204, headers: corsHeaders() })
        );
      }

      let response;
      switch (path) {
        case "/api/retrieve":
        case "/api/search":
          response = await handleSearch(request, env);
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

      const corsResponse = new Response(response.body, response);
      for (const [k, v] of Object.entries(corsHeaders())) {
        corsResponse.headers.set(k, v);
      }
      return withHeaders(corsResponse);
    }

    // R2 routes — PDFs, videos, archives (pending R2 activation)
    const pdfResponse = await tryHandlePdfRoute(request, env);
    if (pdfResponse) return withHeaders(pdfResponse);

    const videoResponse = await tryHandleVideoRoute(request, env);
    if (videoResponse) return withHeaders(videoResponse);

    const archiveResponse = await tryHandleArchiveRoute(request, env);
    if (archiveResponse) return withHeaders(archiveResponse);

    return withHeaders(
      new Response(
        JSON.stringify({ error: "not found", hint: "API endpoints: /api/search, /api/retrieve, /api/tranche-status" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );
  },
};