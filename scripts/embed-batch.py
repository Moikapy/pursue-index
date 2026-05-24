#!/usr/bin/env python3
"""Generate embeddings for pursue-api pages using Ollama batch /api/embed.
Outputs NDJSON for Vectorize batch upsert.

Usage: python3 embed-batch.py [--batch-size 50] [--limit 0]
"""

import json
import sys
import time
import urllib.request
import argparse

OLLAMA_EMBED_URL = "http://localhost:11434/api/embed"
MODEL = "nomic-embed-text"
PAGES_PATH = "/mnt/5tb/pursue-index/data-api/data/pages.json"
OUTPUT_PATH = "/mnt/5tb/pursue-index/data-api/vectorize-upsert.ndjson"


def embed_batch(texts, retries=3):
    """Call Ollama batch embed API. Returns list of embeddings."""
    payload = json.dumps({"model": MODEL, "input": texts}).encode()
    req = urllib.request.Request(
        OLLAMA_EMBED_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                d = json.loads(resp.read())
                return d.get("embeddings", [])
        except Exception as e:
            if attempt == retries - 1:
                print(f"  ERROR batch: {e}", file=sys.stderr)
                return [[] for _ in texts]
            time.sleep(2 ** attempt)
    return [[] for _ in texts]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=100, help="Pages per Ollama batch")
    parser.add_argument("--limit", type=int, default=0, help="Max pages (0=all)")
    args = parser.parse_args()

    with open(PAGES_PATH) as f:
        pages = json.load(f)

    if args.limit:
        pages = pages[:args.limit]

    total = len(pages)
    bs = args.batch_size
    print(f"Embedding {total} pages with {MODEL} (batch={bs})...")

    all_vectors = []
    start_time = time.time()

    for i in range(0, total, bs):
        batch = pages[i:i + bs]
        texts = [p.get("title", "") + ". " + p.get("text", "")[:1500] for p in batch]
        
        embeddings = embed_batch(texts)
        
        for p, emb in zip(batch, embeddings):
            if not emb:
                continue
            all_vectors.append({
                "id": p["id"],
                "values": emb,
                "metadata": {
                    "card_id": p["card_id"],
                    "page": p["page"],
                    "title": p.get("title", "")[:200],
                }
            })

        done = min(i + bs, total)
        elapsed = time.time() - start_time
        rate = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / rate if rate > 0 else 0
        print(f"  {done}/{total} ({rate:.1f}/s, ETA {eta/60:.1f}m)")

    # Write NDJSON
    with open(OUTPUT_PATH, "w") as f:
        for v in all_vectors:
            f.write(json.dumps(v) + "\n")

    elapsed = time.time() - start_time
    print(f"\nDone! {len(all_vectors)} vectors in {elapsed:.0f}s ({len(all_vectors)/elapsed:.1f}/s)")
    print(f"Written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()