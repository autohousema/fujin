/**
 * Fujin — Autonomous Avito.ma bulk scraper (Largus logic, Avito target).
 * ======================================================================
 * Provenance: direct port of Largus-scraper/scraper/index.ts
 *   axios + cheerio (no browser) → fetchPage with retries
 *   structured-data-first (__NEXT_DATA__ instead of JSON-LD)
 *   progress.json resume after every page
 *   MAX_RUNTIME time-box + graceful exit for GitHub Actions 6h limit
 *   append-only JSONL + gzip-friendly commits + DONE sentinel + self-chain
 *
 * Avito specifics (verified against AutoHouse scratch_next_data/scratch_ad):
 *   list:  GET {BASE}/?o={page} → __NEXT_DATA__.props.pageProps.componentProps.ads.ads[]
 *          (~38 ads/page, each already has price/year/km/fuel/gearbox/seller/location)
 *   → NO detail visits in v1 (10-20x faster, enough for DGX sale-price model).
 *   detail enrichment (--enrich) reserved for doors/fiscal/customs/options later.
 *
 * Filters (DGX contract): year >= --min-year (default 2020), sale price only
 * (drops "0 DH", flags "/ mois" monthly as non-training). Phone numbers are
 * NEVER stored raw — SHA-256 hash only (repost dedup, CNDP/GDPR).
 *
 * Usage:
 *   npx tsx scraper/avito.ts --time-budget 345 --min-year 2020
 *   npx tsx scraper/avito.ts --time-budget 2 --max-pages 2   (smoke test)
 */

import axios from "axios";
import * as cheerio from "cheerio";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL =
  "https://www.avito.ma/fr/maroc/voitures_d_occasion-%C3%A0_vendre";
const SCRAPER_DIR = __dirname;
const ROOT_DIR = path.resolve(SCRAPER_DIR, "..");
const DATA_RAW_DIR = path.join(ROOT_DIR, "data", "raw");
const PROGRESS_FILE = path.join(SCRAPER_DIR, "progress.json");
const SEEN_FILE = path.join(ROOT_DIR, "data", "seen_ids.json");
const ERROR_LOG = path.join(SCRAPER_DIR, "error.log");
const DONE_FILE = path.join(SCRAPER_DIR, "DONE");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const randomOf = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const jitter = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min));

// ─── CLI ───────────────────────────────────────────────────────────────────

interface Args {
  timeBudgetMin: number;
  startPage: number;
  minYear: number;
  maxPages: number;
  delayMin: number;
  delayMax: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    timeBudgetMin: parseInt(get("--time-budget", "345"), 10),
    startPage: parseInt(get("--start-page", "0"), 10), // 0 = resume from progress
    minYear: parseInt(get("--min-year", "2020"), 10),
    maxPages: parseInt(get("--max-pages", "0"), 10), // 0 = unlimited until budget/DONE
    delayMin: parseInt(get("--delay-min", "1500"), 10),
    delayMax: parseInt(get("--delay-max", "3500"), 10),
  };
}

// ─── Progress (Largus pattern) ─────────────────────────────────────────────

interface Progress {
  nextPage: number;
  totalSeen: number;
  kept: number;
  skippedOld: number;
  skippedNoPrice: number;
  skippedMonthly: number;
  fallbackCount: number;
  errors: number;
  updatedAt: string;
}

function defaultProgress(startPage: number): Progress {
  return {
    nextPage: startPage > 0 ? startPage : 1,
    totalSeen: 0,
    kept: 0,
    skippedOld: 0,
    skippedNoPrice: 0,
    skippedMonthly: 0,
    fallbackCount: 0,
    errors: 0,
    updatedAt: new Date().toISOString(),
  };
}

function loadProgress(startPage: number): Progress {
  if (startPage > 0) return defaultProgress(startPage);
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
      return { ...defaultProgress(1), ...p };
    }
  } catch {
    /* corrupted progress → restart */
  }
  return defaultProgress(1);
}

function saveProgress(p: Progress) {
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function loadSeen(): Set<string> {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SEEN_FILE, "utf-8"));
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveSeen(seen: Set<string>) {
  // Cap file growth: keep last 200k ids (far beyond 6h yield, avoids GB json)
  const arr = Array.from(seen);
  const trimmed = arr.length > 200_000 ? arr.slice(arr.length - 200_000) : arr;
  fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed));
}

function logError(message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(ERROR_LOG, line);
}

// ─── Fetch (Largus fetchPage + AutoHouse fallback) ─────────────────────────

let fallbackDisabled = false;
let fallbackStrikes = 0;

/** Browser fallback that can NEVER crash the run (circuit breaker). */
async function tryBrowserFallback(url: string): Promise<string | null> {
  if (fallbackDisabled) return null;
  try {
    const mod: any = await import("./fallback.js").catch(() => null);
    if (!mod?.fetchWithBrowser) return null;
    if (mod.isFallbackBroken?.()) {
      fallbackDisabled = true;
      return null;
    }
    const html: string = await mod.fetchWithBrowser(url);
    if (html && html.length > 2000) {
      fallbackStrikes = 0;
      return html;
    }
    return null;
  } catch (fbErr: any) {
    fallbackStrikes++;
    console.error(
      `  fallback failed (${fallbackStrikes}/3): ${fbErr?.message ?? fbErr}`
    );
    logError(`Browser fallback failed for ${url}: ${fbErr?.message ?? fbErr}`);
    if (fallbackStrikes >= 3) {
      fallbackDisabled = true;
      try {
        const mod: any = await import("./fallback.js").catch(() => null);
        mod?.markFallbackBroken?.("3 consecutive failures");
      } catch {
        /* ignore */
      }
      console.error("  fallback disabled for rest of run (primary-only mode)");
    }
    return null;
  }
}

async function fetchPage(
  url: string,
  retries = 3
): Promise<{ html: string; viaFallback: boolean }> {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[GET] ${url}`);
      const res = await axios.get(url, {
        headers: {
          "User-Agent": randomOf(USER_AGENTS),
          "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          Referer: "https://www.avito.ma/",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
        },
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: (s) => s < 500, // 4xx handled below (no blind retry on 404)
      });
      if (res.status === 404) return { html: "", viaFallback: false };
      if (res.status === 403 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (typeof res.data !== "string" || res.data.length < 2000) {
        throw new Error(`suspicious body (${res.data?.length ?? 0} chars)`);
      }
      return { html: res.data, viaFallback: false };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const status = err?.response?.status;
      console.error(`  fetch attempt ${i + 1}/${retries} failed: ${msg}`);
      if (status === 404) return { html: "", viaFallback: false };
      if (i === retries - 1) {
        // Last resort: AutoHouse browser fallback (never fatal — see helper)
        const fbHtml = await tryBrowserFallback(url);
        if (fbHtml) return { html: fbHtml, viaFallback: true };
        logError(`Failed to fetch ${url} after ${retries} attempts: ${msg}`);
        return { html: "", viaFallback: false };
      }
      // Longer backoff on 403/429 (GH IPs are flagged); standard 5s otherwise
      const blocked = status === 403 || status === 429 || /403|429/.test(msg);
      await delay(blocked ? 15000 + jitter(0, 10000) : 5000 + jitter(0, 3000));
    }
  }
  return { html: "", viaFallback: false };
}

// ─── Parse (Avito __NEXT_DATA__ = Largus JSON-LD equivalent) ───────────────

function extractNextData(html: string): any | null {
  try {
    const $ = cheerio.load(html);
    const raw = $("script#__NEXT_DATA__").html();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function paramValue(params: any, key: string): any {
  for (const group of ["primary", "secondary", "extra"]) {
    const list = params?.[group];
    if (Array.isArray(list)) {
      const hit = list.find((p: any) => p?.key === key);
      if (hit) return hit.value;
    }
  }
  return null;
}

function hashPhone(phone: unknown): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  return crypto.createHash("sha256").update(digits).digest("hex");
}

export interface ParsedListing {
  listing_id: string;
  url: string;
  source: string;
  title_raw: string;
  price_mad: number | null;
  price_type: "sale" | "monthly" | "missing";
  monthly_mad: number | null;
  year: number | null;
  mileage_km: number | null;
  fuel_type: string | null;
  transmission: string | null;
  city: string | null;
  location_raw: string | null;
  seller_type: string | null;
  seller_name: string | null;
  seller_phone_hash: string | null;
  photos_count: number;
  description_raw: string | null;
  date_posted_raw: string | null;
  scraped_at: string;
  raw: unknown; // full per-ad JSON for re-parsing (DGX "full raw" contract)
}

export function parseAd(ad: any): ParsedListing | null {
  const id = ad?.id ? String(ad.id) : null;
  const href: string | null = ad?.href ?? null;
  if (!id || !href) return null;

  const priceVal = ad?.price?.value;
  const price_mad =
    typeof priceVal === "number" && priceVal > 0 ? Math.round(priceVal) : null;
  const monthlyVal = ad?.monthlyPayment?.value;
  const monthly_mad =
    typeof monthlyVal === "number" && monthlyVal > 0
      ? Math.round(monthlyVal)
      : null;
  const price_type: ParsedListing["price_type"] = price_mad
    ? "sale"
    : monthly_mad
      ? "monthly"
      : "missing";

  const yearRaw = paramValue(ad?.params, "regdate");
  let year: number | null = null;
  if (yearRaw != null) {
    const y = parseInt(String(yearRaw), 10);
    if (y >= 1980 && y <= new Date().getFullYear() + 1) year = y;
  }
  if (year == null) {
    // Title fallback (same regex as Selenium scraper _extract_specs)
    const m = String(ad?.subject ?? "").match(/\b(19|20)\d{2}\b/);
    if (m) {
      const y = parseInt(m[0], 10);
      if (y >= 1980 && y <= new Date().getFullYear() + 1) year = y;
    }
  }

  const milRaw = paramValue(ad?.params, "mileage_exact");
  let mileage_km: number | null = null;
  if (typeof milRaw === "number" && milRaw >= 0) mileage_km = Math.round(milRaw);
  else if (milRaw != null) {
    const digits = String(milRaw).replace(/\D/g, "");
    if (digits) mileage_km = parseInt(digits, 10);
  }

  const locationRaw =
    typeof ad?.location === "string"
      ? ad.location
      : (ad?.location?.city ?? null);
  const city = locationRaw ? String(locationRaw).split(",")[0].trim() || null : null;

  const sellerRawType = String(ad?.seller?.type ?? "").toUpperCase();
  const seller_type =
    sellerRawType === "STORE" || sellerRawType === "SHOP"
      ? "Professionnel"
      : sellerRawType
        ? "Particulier"
        : null;

  const images = Array.isArray(ad?.images) ? ad.images : [];

  return {
    listing_id: id,
    url: href.split("?")[0],
    source: "avito",
    title_raw: String(ad?.subject ?? ""),
    price_mad,
    price_type,
    monthly_mad,
    year,
    mileage_km,
    fuel_type: paramValue(ad?.params, "fuel") ?? null,
    transmission: paramValue(ad?.params, "bv") ?? null,
    city,
    location_raw: locationRaw ? String(locationRaw) : null,
    seller_type,
    seller_name: ad?.seller?.name ? String(ad.seller.name) : null,
    seller_phone_hash: hashPhone(ad?.seller?.phone?.number ?? ad?.phone),
    photos_count: images.length,
    description_raw: ad?.description ? String(ad.description) : null,
    date_posted_raw: ad?.date ? String(ad.date) : null,
    scraped_at: new Date().toISOString(),
    raw: ad,
  };
}

// ─── Main (Largus run() shape, flat Avito pagination) ──────────────────────

async function run() {
  const args = parseArgs();
  console.log("Fujin Avito scraper starting...");
  console.log(
    `  budget=${args.timeBudgetMin}min minYear=${args.minYear} maxPages=${args.maxPages || "∞"}`
  );

  if (fs.existsSync(DONE_FILE)) {
    console.log("DONE file present — previous chain finished. Removing to allow fresh run.");
    fs.unlinkSync(DONE_FILE);
  }

  const MAX_RUNTIME_MS = args.timeBudgetMin * 60 * 1000;
  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(DATA_RAW_DIR, { recursive: true });
  const outFile = path.join(DATA_RAW_DIR, `avito_${today}.jsonl`);

  let progress = loadProgress(args.startPage);
  const seen = loadSeen();
  console.log(`Resuming from page ${progress.nextPage} (seen=${seen.size}) → ${outFile}`);

  let page = progress.nextPage;
  let emptyStreak = 0;
  let pagesDone = 0;

  while (true) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      console.log("Reached time budget. Stopping gracefully to allow commit + chain.");
      break;
    }
    if (args.maxPages > 0 && pagesDone >= args.maxPages) {
      console.log(`Reached --max-pages ${args.maxPages}.`);
      break;
    }

    const url = page <= 1 ? BASE_URL : `${BASE_URL}?o=${page}`;
    const { html, viaFallback } = await fetchPage(url);
    if (viaFallback) progress.fallbackCount++;

    if (!html) {
      progress.errors++;
      logError(`Empty response page ${page}: ${url}`);
      emptyStreak++;
      saveProgress(progress);
      if (emptyStreak >= 5) {
        console.log("5 consecutive empty pages → assuming exhaustion, writing DONE.");
        fs.writeFileSync(DONE_FILE, "done");
        break;
      }
      page++;
      progress.nextPage = page;
      continue;
    }

    const nextData = extractNextData(html);
    const ads: any[] =
      nextData?.props?.pageProps?.componentProps?.ads?.ads ?? [];

    if (!ads.length) {
      console.log(`Page ${page}: no ads in __NEXT_DATA__`);
      // One browser-fallback attempt for list pages missing JSON (challenge HTML)
      if (!viaFallback) {
        const fbHtml = await tryBrowserFallback(url);
        if (fbHtml) {
          const fbData = extractNextData(fbHtml);
          const fbAds: any[] =
            fbData?.props?.pageProps?.componentProps?.ads?.ads ?? [];
          if (fbAds.length) {
            progress.fallbackCount++;
            await handleAds(fbAds, args, seen, progress, outFile);
            emptyStreak = 0;
            page++;
            progress.nextPage = page;
            pagesDone++;
            saveProgress(progress);
            saveSeen(seen);
            await delay(jitter(args.delayMin, args.delayMax));
            continue;
          }
        }
      }
      emptyStreak++;
      progress.errors++;
      saveProgress(progress);
      if (emptyStreak >= 5) {
        fs.writeFileSync(DONE_FILE, "done");
        break;
      }
      page++;
      progress.nextPage = page;
      await delay(jitter(args.delayMin, args.delayMax));
      continue;
    }

    emptyStreak = 0;
    await handleAds(ads, args, seen, progress, outFile);

    page++;
    progress.nextPage = page;
    pagesDone++;
    saveProgress(progress);
    if (pagesDone % 5 === 0) saveSeen(seen);
    await delay(jitter(args.delayMin, args.delayMax));
  }

  saveProgress(progress);
  saveSeen(seen);
  try {
    const { closeBrowser } = await import("./fallback.js").catch(() => null as any);
    if (closeBrowser) await closeBrowser();
  } catch {
    /* ignore */
  }
  console.log(
    `\n✅ Fujin run done: seen=${progress.totalSeen} kept=${progress.kept} ` +
      `old(<${args.minYear})=${progress.skippedOld} monthly=${progress.skippedMonthly} ` +
      `noprice=${progress.skippedNoPrice} fallback=${progress.fallbackCount} errors=${progress.errors}`
  );
}

async function handleAds(
  ads: any[],
  args: Args,
  seen: Set<string>,
  progress: Progress,
  outFile: string
) {
  let fresh = 0;
  for (const ad of ads) {
    const id = ad?.id ? String(ad.id) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    progress.totalSeen++;
    fresh++;

    const parsed = parseAd(ad);
    if (!parsed) {
      progress.errors++;
      continue;
    }
    // DGX filters (warn + count, raw preserved for audit)
    if (parsed.year != null && parsed.year < args.minYear) {
      progress.skippedOld++;
    } else if (parsed.price_type === "monthly") {
      progress.skippedMonthly++;
    } else if (parsed.price_type === "missing") {
      progress.skippedNoPrice++;
    } else {
      progress.kept++;
    }
    fs.appendFileSync(outFile, JSON.stringify(parsed) + "\n");
  }
  console.log(
    `Page → ${ads.length} ads (${fresh} new) | kept=${progress.kept} old=${progress.skippedOld} monthly=${progress.skippedMonthly} noprice=${progress.skippedNoPrice}`
  );
}

run().catch((e) => {
  logError(`Fatal: ${e?.stack ?? e}`);
  console.error(e);
  process.exit(1);
});
