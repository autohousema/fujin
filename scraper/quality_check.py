#!/usr/bin/env python3
"""
Fujin quality_check — warn-only gates (never fails the workflow).
==================================================================
Thresholds protect DGX training from silent degradation:
  - price_missing + monthly share too high  -> warn
  - year null share too high                -> warn (selectors may have broken)
  - training rows == 0                      -> warn
Exit code is ALWAYS 0 (commit must proceed; see plan).
"""
import glob
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

WARN_PRICE_NON_SALE_PCT = 40.0
WARN_YEAR_NULL_PCT = 15.0


def load_rows() -> list:
    rows = []
    for f in sorted(glob.glob(str(ROOT / "data" / "raw" / "avito_*.jsonl"))):
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        pass
    return rows


def main() -> int:
    rows = load_rows()
    if not rows:
        print("WARN: no raw rows found — nothing scraped yet.")
        return 0
    # DGX-relevant subset: year >= 2020 (or unknown, quarantined separately)
    in_scope = [
        r
        for r in rows
        if r.get("year") is None or (isinstance(r.get("year"), int) and r["year"] >= 2020)
    ]
    n = len(in_scope)
    if not n:
        print("WARN: no in-scope (>=2020) rows.")
        return 0
    non_sale = sum(1 for r in in_scope if r.get("price_type") != "sale")
    year_null = sum(1 for r in in_scope if r.get("year") is None)
    old = sum(
        1
        for r in rows
        if isinstance(r.get("year"), int) and r["year"] < 2020
    )
    sale = n - non_sale
    warnings = []
    if non_sale / n * 100 > WARN_PRICE_NON_SALE_PCT:
        warnings.append(
            f"non-sale price share {non_sale/n*100:.1f}% > {WARN_PRICE_NON_SALE_PCT}%"
        )
    if year_null / n * 100 > WARN_YEAR_NULL_PCT:
        warnings.append(
            f"year-null share {year_null/n*100:.1f}% > {WARN_YEAR_NULL_PCT}% (check __NEXT_DATA__ selectors)"
        )
    if sale == 0:
        warnings.append("zero sale-price rows — DGX training input would be empty")
    print(f"rows={n} sale={sale} non_sale={non_sale} year_null={year_null} old(<2020)={old}")
    for w in warnings:
        print(f"WARN: {w}", file=sys.stderr)
    if not warnings:
        print("quality OK")
    return 0  # warn-only by design


if __name__ == "__main__":
    raise SystemExit(main())
