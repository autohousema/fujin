#!/usr/bin/env python3
"""
Fujin to_parquet — JSONL -> DGX-ready Parquet.
=============================================
Reads data/raw/avito_*.jsonl (written by scraper/avito.ts),
dedups by listing_id, applies DGX contract filters, writes:

  data/processed/listings.parquet            (all, year >= MIN_YEAR incl. monthly/missing w/ flags)
  data/processed/used_car_training.parquet   (sale price present only — DGX training input)
  reports/quality_report.json                (warn-only metrics)

MIN_YEAR defaults to 2020 (matches --min-year scraper flag).
Falls back to CSV if pandas/pyarrow are unavailable (CI without deps).
"""
import argparse
import glob
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_GLOB = str(ROOT / "data" / "raw" / "avito_*.jsonl")
PROCESSED = ROOT / "data" / "processed"
REPORTS = ROOT / "reports"


def load_rows(pattern: str) -> list:
    rows = []
    for f in sorted(glob.glob(pattern)):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-year", type=int, default=2020)
    ap.add_argument("--pattern", default=RAW_GLOB)
    args = ap.parse_args()

    PROCESSED.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)

    rows = load_rows(args.pattern)
    seen: dict = {}
    for r in rows:
        lid = str(r.get("listing_id", ""))
        if lid and lid not in seen:
            seen[lid] = r
    deduped = list(seen.values())

    def keep_all(r: dict) -> bool:
        y = r.get("year")
        return y is None or (isinstance(y, int) and y >= args.min_year)

    listings = [r for r in deduped if keep_all(r)]
    dropped_old = len(deduped) - len(listings)

    training = [
        r
        for r in listings
        if r.get("price_type") == "sale"
        and isinstance(r.get("price_mad"), int)
        and isinstance(r.get("year"), int)
        and isinstance(r.get("mileage_km"), int)
    ]

    # Flatten `raw` out of parquet (kept in JSONL for re-parse); keep typed cols.
    cols = [
        "listing_id", "url", "source", "title_raw", "price_mad", "price_type",
        "monthly_mad", "year", "mileage_km", "fuel_type", "transmission",
        "city", "location_raw", "seller_type", "seller_name",
        "seller_phone_hash", "photos_count", "description_raw",
        "date_posted_raw", "scraped_at",
    ]

    def project(rs: list) -> list:
        out = []
        for r in rs:
            out.append({c: r.get(c) for c in cols})
        return out

    report = {
        "generated_at": datetime.now().isoformat(),
        "min_year": args.min_year,
        "raw_rows": len(rows),
        "deduped": len(deduped),
        "listings_ge_min_year": len(listings),
        "dropped_old": dropped_old,
        "training_rows": len(training),
        "price_types": {},
        "null_year": sum(1 for r in listings if r.get("year") is None),
    }
    for r in listings:
        t = r.get("price_type", "missing")
        report["price_types"][t] = report["price_types"].get(t, 0) + 1

    try:
        import pandas as pd  # type: ignore

        listings_df = pd.DataFrame(project(listings), columns=cols)
        training_df = pd.DataFrame(project(training), columns=cols)
        listings_df.to_parquet(PROCESSED / "listings.parquet", index=False)
        training_df.to_parquet(PROCESSED / "used_car_training.parquet", index=False)
        report["format"] = "parquet"
        print(f"wrote {len(listings_df)} listings + {len(training_df)} training -> parquet")
    except Exception as e:
        import csv

        for name, rs in [("listings", listings), ("used_car_training", training)]:
            with open(PROCESSED / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=cols)
                w.writeheader()
                w.writerows(project(rs))
        report["format"] = f"csv_fallback ({e})"
        print(f"parquet unavailable, wrote CSV fallback: {e}", file=sys.stderr)

    with open(REPORTS / "quality_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
