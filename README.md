# Fujin — Autonomous Avito.ma scraper for DGX A100 training

> Bulk market scrape (NOT boutique import). Target: all Avito cars with `year >= 2020`,
> sale asking-price only, for Moroccan price-evaluation model trained on DGX A100.

Pattern proven by `Largus-scraper` (300k-page scale), ported 1:1 to Avito:

| Largus | Fujin (Avito) |
|---|---|
| `axios + cheerio`, no browser | Same primary. `__NEXT_DATA__` instead of JSON-LD |
| `ItemList` brand→model→year→version tree | Flat search pagination `?o={page}` (~38 ads/page already contain price/year/km/fuel/seller) |
| `progress.json` 4 indices | `progress.json {nextPage, seenIds, kept, skippedOld, ...}` |
| 5h cap + graceful exit | `--time-budget 345` (5h45, under 6h GH limit) |
| `data.jsonl.gz` + self-chain | Same: gzip + `repository_dispatch` chain + `DONE` sentinel |

Fallback: AutoHouse `puppeteer-stealth` browser fetch (`scraper/fallback.ts`,
ported from `AutoHouse-main/lib/browser.ts`) — used ONLY when HTTP gets
403/challenge or `__NEXT_DATA__` is missing. Legacy Selenium
(`scraper/avito_scraper.py`) is NOT used.

## Quick start

```bash
cd Fujin
npm install
npm run scrape:dry        # 2 min / 2 pages smoke test
npm run scrape -- --time-budget 345 --min-year 2020
python3 scraper/to_parquet.py      # JSONL -> data/processed/*.parquet
python3 scraper/quality_check.py   # warn-only gates
```

## Outputs (DGX-ready)

- `data/raw/avito_YYYYMMDD.jsonl` — one JSON per listing, includes full per-ad
  `raw` object for re-parsing without re-scraping.
- `data/processed/listings.parquet` — deduped, `year >= 2020` only.
- `data/processed/used_car_training.parquet` — `sale` price present,
  `is_new=False`-style filter (drops monthly-only / missing price).
- `reports/quality_report.json` — warn-only, never blocks commit.
- `scraper/progress.json`, `scraper/error.log` — resume + audit.

## GitHub Actions

`.github/workflows/scrape.yml`: manual + `repository_dispatch[continue_scraping]`
chain, `timeout-minutes: 360`, single concurrency, Node 20 + Python parquet step,
commits `*.jsonl.gz + progress.json + error.log + processed/*.parquet`,
re-triggers itself unless `scraper/DONE` exists.

## DGX contract

Consume `used_car_training.parquet` with **temporal split** (`sort date_scraped
70/15/15`), group by `repost_group_id` to avoid leakage. Labels are
**asking prices, 2020+ only** — inference must reject `<2020` as hors périmètre.
