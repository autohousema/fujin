/**
 * Fujin — browser fallback fetcher (AutoHouse setup).
 * =====================================================
 * Ported from AutoHouse-main/lib/browser.ts (puppeteer-extra + stealth).
 * Used ONLY when primary axios fetch gets 403 / Cloudflare challenge
 * or when __NEXT_DATA__ is missing from the HTTP response.
 *
 * Optional deps (see package.json optionalDependencies):
 *   puppeteer-core, puppeteer-extra, puppeteer-extra-plugin-stealth,
 *   @sparticuz/chromium-min
 * If they are not installed (local smoke test), this throws a clear
 * error and the caller skips the page instead of crashing the run.
 */

let cachedBrowser: any = null;

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

  const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;
  let executablePath: string | undefined;

  if (!isCI) {
    const fs = await import("fs");
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!executablePath) {
      throw new Error("No local Chrome found for browser fallback");
    }
  } else {
    const { default: chromium } = await import("@sparticuz/chromium-min");
    executablePath = await chromium.executablePath(
      "https://github.com/nicobytes/nicobytes-downloads/releases/download/v131.0.1/chromium-v131.0.1-pack.tar"
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
