/**
 * Fujin — browser fallback fetcher (AutoHouse setup, CI-safe).
 * ============================================================
 * Ported from AutoHouse-main/lib/browser.ts (puppeteer-extra + stealth).
 * Used ONLY when primary axios fetch gets 403 / Cloudflare challenge
 * or when __NEXT_DATA__ is missing from the HTTP response.
 *
 * Chrome resolution order (NO remote tarball downloads — the
 * @sparticuz/chromium-min tarball proved flaky in CI with
 * "Invalid tar header" crashes that escape try/catch via EventEmitter):
 *   1. $CHROME_PATH (set by browser-actions/setup-chrome in CI)
 *   2. Well-known local paths
 *
 * Optional deps (see package.json optionalDependencies):
 *   puppeteer-core, puppeteer-extra, puppeteer-extra-plugin-stealth.
 * If they are not installed, this throws a clear error and the caller
 * skips the page instead of crashing the run.
 */

let cachedBrowser: any = null;
let fallbackBroken = false;

async function fsExists(p: string): Promise<boolean> {
  try {
    const fs = await import("fs");
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function isFallbackBroken(): boolean {
  return fallbackBroken;
}

export function markFallbackBroken(reason: string): void {
  if (!fallbackBroken) {
    fallbackBroken = true;
    console.error(`  fallback disabled for rest of run: ${reason}`);
  }
}

async function getBrowser(): Promise<any> {
  // Dynamic imports so `npm install` without optional deps still works.
  const { default: puppeteerExtraRaw } = await import("puppeteer-extra").catch(() => {
    throw new Error("puppeteer-extra not installed — browser fallback unavailable");
  });
  const puppeteerExtra: any = puppeteerExtraRaw;
  const { default: StealthPlugin } = await import(
    "puppeteer-extra-plugin-stealth"
  ).catch(() => {
    throw new Error("puppeteer-extra-plugin-stealth not installed");
  });
  puppeteerExtra.use(StealthPlugin());

  if (cachedBrowser?.connected) return cachedBrowser;

  // 1. CI-provided Chrome (browser-actions/setup-chrome sets CHROME_PATH)
  // 2. Well-known local paths. No remote tarball downloads.
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];

  let executablePath: string | undefined;
  for (const p of candidates) {
    if (await fsExists(p)) {
      executablePath = p;
      break;
    }
  }
  if (!executablePath) {
    throw new Error(
      "No Chrome binary found (set CHROME_PATH via browser-actions/setup-chrome)"
    );
  }

  cachedBrowser = await (puppeteerExtra as any).launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
  });
  return cachedBrowser;
}

export async function fetchWithBrowser(url: string): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    let retries = 0;
    while (retries < 15) {
      const content: string = await page.content();
      if (
        !content.includes("challenges.cloudflare.com") &&
        !content.includes("Just a moment...")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
      retries++;
    }
    await new Promise((r) => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    await cachedBrowser.close().catch(() => {});
    cachedBrowser = null;
  }
}
