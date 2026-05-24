#!/usr/bin/env python3
"""Generate embeddings for pursue-api pages using local Ollama nomic-embed-text.
Outputs NDJSON file for Vectorize batch upsert.

Usage: python3 embed-pages.py [--batch-size 50] [--limit 0]
"""

import json
import sys
import time
import urllib.request
import urllib.error
import argparse

OLLAMA_EMBED_URL = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"
PAGES_PATH = "/mnt/5tb/pursue-index/data-api/data/pages.json"
OUTPUT_PATH = "/mnt/5tb/pursue-index/data-api/vectorize-upsert.json"

def embed_texts(texts, batch_retries=3):
    """Call Ollama embedding API for a list of texts. Returns list of embeddings."""
    results = []
    for text in texts:
        payload = json.dumps({"model": MODEL, "prompt": text}).encode()
        req = urllib.request.Request(
            OLLAMA_EMBED_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        for attempt in range(batch_retries):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    d = json.loads(resp.read())
                    results.append(d.get("embedding", []))
                    break
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == batch_retries - 1:
                    print(f"  ERROR embedding after {batch_retries} tries: {e}", file=sys.stderr)
                    results.append([])
                else:
                    time.sleep(2 ** attempt)
    return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=50, help="Pages per Ollama batch")
    parser.add_argument("--limit", type=int, default=0, help="Max pages to embed (0=all)")
    parser.add_argument("--start", type=int, default=0, help="Start index")
    args = parser.parse_args()

    with open(PAGES_PATH) as f:
        pages = json.load(f)

    if args.start:
        pages = pages[args.start:]
    if args.limit:
        pages = pages[:args.limit]

    total = len(pages)
    print(f"Embedding {total} pages with {MODEL}...")
    print(f"Output: {OUTPUT_PATH}")

    batch_size = args.batch_size
    vectors = []
    start_time = time.time()

    for i in range(0, total, batch_size):
        batch = pages[i:i + batch_size]
        # Combine title + text for embedding (title weighted more via duplication)
        texts = []
        for p in batch:
            t = p.get("title", "") + ". " + p.get("text", "")[:1500]
            texts.append(t)

        embeddings = embed_texts(texts)

        for p, emb in zip(batch, embeddings):
            if not emb:
                continue
            vectors.append({
                "id": p["id"],
                "values": emb,
                "metadata": {
                    "card_id": p["card_id"],
                    "page": p["page"],
                    "title": p.get("title", "")[:200],
                }
            })

        done = min(i + batch_size, total)
        elapsed = time.time() - start_time
        rate = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / rate if rate > 0 else 0
        print(f"  {done}/{total} ({rate:.1f}/s, ETA {eta/60:.1f}m)")

    with open(OUTPUT_PATH, "w") as f:
        json.dump(vectors, f)

    elapsed = time.time() - start_time
    print(f"\nDone! {len(vectors)} vectors in {elapsed:.0f}s")
    print(f"Written to {OUTPUT_PATH}")
    print(f"Size: {len(json.dumps(vectors))//1024//1024} MB")

if __name__ == "__main__":
    main()