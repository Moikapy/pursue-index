#!/usr/bin/env python3
"""Embed pursue-api pages using Cloudflare Workers AI (qwen3-embedding-0.6b)
and upsert to Vectorize index. Runs once to populate the index.

Usage: python3 embed-to-vectorize.py [--batch-size 50] [--limit 0]

Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import argparse

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
MODEL = "@cf/qwen/qwen3-embedding-0.6b"
PAGES_PATH = "/mnt/5tb/pursue-index/data-api/data/pages.json"
INDEX_NAME = "pursue-embeddings"

EMBED_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}"
UPSERT_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/vectorize/v2/indexes/{INDEX_NAME}/upsert"


def embed_batch(texts, retries=3):
    """Call Workers AI to embed a batch of texts."""
    payload = json.dumps({"text": texts}).encode()
    req = urllib.request.Request(
        EMBED_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
                if d.get("success") and d.get("result"):
                    return d["result"].get("data", [])
                else:
                    errors = d.get("errors", [])
                    print(f"  API error: {errors}", file=sys.stderr)
                    return []
        except Exception as e:
            if attempt == retries - 1:
                print(f"  ERROR batch: {e}", file=sys.stderr)
                return []
            time.sleep(2 ** attempt)
    return []


def upsert_vectors(vectors, retries=3):
    """Upsert vectors to Vectorize."""
    payload = json.dumps({"vectors": vectors}).encode()
    req = urllib.request.Request(
        UPSERT_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
                return d.get("success", False)
        except Exception as e:
            if attempt == retries - 1:
                print(f"  ERROR upsert: {e}", file=sys.stderr)
                return False
            time.sleep(2 ** attempt)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=50, help="Pages per embed batch")
    parser.add_argument("--upsert-size", type=int, default=100, help="Vectors per upsert batch")
    parser.add_argument("--limit", type=int, default=0, help="Max pages (0=all)")
    args = parser.parse_args()

    if not ACCOUNT_ID or not API_TOKEN:
        print("ERROR: Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars")
        sys.exit(1)

    with open(PAGES_PATH) as f:
        pages = json.load(f)

    if args.limit:
        pages = pages[:args.limit]

    total = len(pages)
    print(f"Embedding {total} pages with {MODEL} via Workers AI...")

    # Phase 1: Embed all pages
    all_vectors = []
    start_time = time.time()

    for i in range(0, total, args.batch_size):
        batch = pages[i:i + args.batch_size]
        texts = [p.get("title", "") + ". " + p.get("text", "")[:2000] for p in batch]
        
        embeddings = embed_batch(texts)
        if not embeddings:
            print(f"  Skipping batch at {i} — embed failed")
            continue

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
                },
            })

        done = min(i + args.batch_size, total)
        elapsed = time.time() - start_time
        rate = done / elapsed if elapsed > 0 else 0
        print(f"  Embedded {done}/{total} ({rate:.1f}/s, {len(all_vectors)} vectors so far)")

    print(f"\nPhase 1 done: {len(all_vectors)} vectors in {time.time()-start_time:.0f}s")

    # Phase 2: Upsert to Vectorize
    print(f"\nUpserting {len(all_vectors)} vectors to Vectorize in batches of {args.upsert_size}...")
    upserted = 0

    for i in range(0, len(all_vectors), args.upsert_size):
        batch = all_vectors[i:i + args.upsert_size]
        if upsert_vectors(batch):
            upserted += len(batch)
        else:
            print(f"  UPSERT FAILED at {i}!")

        if (i + args.upsert_size) % 500 < args.upsert_size or i + args.upsert_size >= len(all_vectors):
            print(f"  Upserted {upserted}/{len(all_vectors)}")

        # Rate limit: Vectorize upsert is limited
        time.sleep(1)

    elapsed = time.time() - start_time
    print(f"\nDone! {upserted}/{len(all_vectors)} vectors upserted in {elapsed:.0f}s")


if __name__ == "__main__":
    main()