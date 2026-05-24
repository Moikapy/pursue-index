#!/usr/bin/env python3
"""Embed pursue-api pages using Cloudflare Workers AI (qwen3-embedding-0.6b, 1024-dim)
and output NDJSON for Vectorize insertion.

Usage: python3 embed-cloudflare.py [--batch-size 50] [--limit 0]
Output: /mnt/5tb/pursue-index/data-api/vectorize-insert.ndjson

Then insert with:
  wrangler vectorize insert pursue-embeddings --file vectorize-insert.ndjson
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
import argparse

ACCOUNT_ID = "8df8e06821f20acd069d33bc4468cc9a"
MODEL = "@cf/qwen/qwen3-embedding-0.6b"
PAGES_PATH = "/mnt/5tb/pursue-index/data-api/data/pages.json"
OUTPUT_PATH = "/mnt/5tb/pursue-index/data-api/vectorize-insert.ndjson"
EMBED_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}"


def get_cf_token():
    """Extract OAuth token from wrangler config."""
    path = os.path.expanduser("~/.config/.wrangler/config/default.toml")
    with open(path) as f:
        for line in f:
            if line.startswith("oauth_token"):
                return line.split('"')[1]
    return ""


def embed_batch(texts, token, retries=3):
    """Call Workers AI to embed a batch of texts."""
    payload = json.dumps({"text": texts}).encode()
    req = urllib.request.Request(
        EMBED_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
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
                print(f"  ERROR after {retries} tries: {e}", file=sys.stderr)
                return []
            time.sleep(2 ** attempt)
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    token = get_cf_token()
    if not token:
        print("ERROR: No wrangler OAuth token found")
        sys.exit(1)

    with open(PAGES_PATH) as f:
        pages = json.load(f)

    if args.limit:
        pages = pages[:args.limit]

    total = len(pages)
    bs = args.batch_size
    print(f"Embedding {total} pages with Workers AI {MODEL} (batch={bs})...")
    print(f"Output: {OUTPUT_PATH}")

    written = 0
    start_time = time.time()

    with open(OUTPUT_PATH, "w") as outf:
        for i in range(0, total, bs):
            batch = pages[i:i + bs]
            texts = [p.get("title", "") + ". " + p.get("text", "")[:2000] for p in batch]

            embeddings = embed_batch(texts, token)
            if not embeddings:
                print(f"  SKIP batch {i}-{i+bs} — embed failed")
                continue

            for p, emb in zip(batch, embeddings):
                if not emb:
                    continue
                vector = {
                    "id": p["id"],
                    "values": emb,
                    "metadata": {
                        "card_id": p["card_id"],
                        "page": p["page"],
                        "title": p.get("title", "")[:200],
                    },
                }
                outf.write(json.dumps(vector) + "\n")
                written += 1

            done = min(i + bs, total)
            elapsed = time.time() - start_time
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total - done) / rate / 60 if rate > 0 else 0
            print(f"  {done}/{total} ({rate:.1f}/s, {written} vectors, ETA {eta:.1f}m)")

            # Workers AI rate limit — don't hammer it
            time.sleep(0.5)

    elapsed = time.time() - start_time
    print(f"\nDone! {written} vectors in {elapsed:.0f}s")
    print(f"Written to {OUTPUT_PATH}")
    print(f"\nInsert with: wrangler vectorize insert pursue-embeddings --file {OUTPUT_PATH}")


if __name__ == "__main__":
    main()