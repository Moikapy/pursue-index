#!/usr/bin/env python3
"""Generate embeddings for pursue-api pages using local Ollama nomic-embed-text.
Uses concurrent requests for speed. Outputs NDJSON for Vectorize batch upsert.

Usage: python3 embed-pages-fast.py [--workers 4] [--limit 0]
"""

import json
import sys
import time
import urllib.request
import urllib.error
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"
PAGES_PATH = "/mnt/5tb/pursue-index/data-api/data/pages.json"
OUTPUT_PATH = "/mnt/5tb/pursue-index/data-api/vectorize-upsert.ndjson"


def embed_single(args):
    """Embed a single page. Returns (page, embedding)."""
    idx, p, retries = args
    text = p.get("title", "") + ". " + p.get("text", "")[:1500]
    payload = json.dumps({"model": MODEL, "prompt": text}).encode()
    req = urllib.request.Request(
        OLLAMA_EMBED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
                return idx, p, d.get("embedding", [])
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  ERROR page {p['id']}: {e}", file=sys.stderr)
                return idx, p, []
            time.sleep(2 ** attempt)
    return idx, p, []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4, help="Concurrent Ollama requests")
    parser.add_argument("--limit", type=int, default=0, help="Max pages (0=all)")
    parser.add_argument("--start", type=int, default=0, help="Start index")
    args = parser.parse_args()

    with open(PAGES_PATH) as f:
        pages = json.load(f)

    if args.start:
        pages = pages[args.start:]
    if args.limit:
        pages = pages[:args.limit]

    total = len(pages)
    print(f"Embedding {total} pages with {MODEL} ({args.workers} workers)...")

    # Prepare tasks
    tasks = [(i, p, 3) for i, p in enumerate(pages)]

    results = [None] * total
    done = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(embed_single, t): t[0] for t in tasks}
        for future in as_completed(futures):
            idx, page, embedding = future.result()
            results[idx] = (page, embedding)
            done += 1
            if done % 50 == 0 or done == total:
                elapsed = time.time() - start_time
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                print(f"  {done}/{total} ({rate:.1f}/s, ETA {eta/60:.1f}m)")

    # Write NDJSON (one JSON object per line — Vectorize batch format)
    written = 0
    with open(OUTPUT_PATH, "w") as f:
        for r in results:
            if r is None:
                continue
            page, emb = r
            if not emb:
                continue
            vector = {
                "id": page["id"],
                "values": emb,
                "metadata": {
                    "card_id": page["card_id"],
                    "page": page["page"],
                    "title": page.get("title", "")[:200],
                }
            }
            f.write(json.dumps(vector) + "\n")
            written += 1

    elapsed = time.time() - start_time
    print(f"\nDone! {written} vectors in {elapsed:.0f}s ({written/elapsed:.1f}/s)")
    print(f"Written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()