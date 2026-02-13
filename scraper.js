const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const GEM_URL = "https://bidplus.gem.gov.in/all-bids";

function absUrl(u) {
  if (!u) return "";
  if (u.startsWith("http")) return u;
  return "https://bidplus.gem.gov.in" + (u.startsWith("/") ? u : "/" + u);
}

function safeFirst(regex, text) {
  const m = String(text || "").match(regex);
  return m ? m[0] : "";
}

function cleanLines(text) {
  return String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function valueAfterLabel(lines, label) {
  const idx = lines.findIndex((l) =>
    l.toLowerCase().startsWith(label.toLowerCase())
  );
  if (idx === -1) return "";
  return lines[idx + 1] || "";
}

/**
 * Wait until the listing content has refreshed.
 * Works for:
 * - ajax refresh after keyword search
 * - hash pagination (#page-2)
 */
async function waitForListingUpdate(page, { prevFirst = "", prevCount = 0, prevHash = "" } = {}) {
  await page.waitForFunction(
    ({ prevFirst, prevCount, prevHash }) => {
      const cards = document.querySelectorAll(".card");
      const count = cards.length;

      const first = cards[0]?.textContent || "";
      const hash = location.hash || "";

      // any one signal changing is enough
      if (prevHash && hash && hash !== prevHash) return true;
      if (prevCount && count !== prevCount) return true;
      if (prevFirst && first && first !== prevFirst) return true;

      // also accept "cards exist" as a minimum signal
      return count > 0;
    },
    { prevFirst, prevCount, prevHash },
    { timeout: 60000 }
  );

  // small settle for ajax render
  await page.waitForTimeout(500);
}

/**
 * Find the correct Bid Listing keyword input (NOT navbar search).
 * GeM has multiple inputs. We pick:
 * - placeholder contains "Enter Keyword"
 * - id != "search" (navbar)
 * - visible
 * - the one LOWER on the page (largest Y) => typically the Bid Listing box
 */
async function findBidListingKeywordInput(page) {
  const candidates = page.locator(
    'input[placeholder*="Enter Keyword" i], input[placeholder*="Enter Keywords" i]'
  );

  const n = await candidates.count();
  if (!n) return null;

  let picked = null;
  let bestY = -1;

  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);

    const id = ((await el.getAttribute("id")) || "").toLowerCase();
    if (id === "search") continue; // navbar search

    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await el.boundingBox().catch(() => null);
    const y = box ? box.y : 0;

    // choose the one lower on screen (bigger y)
    if (y > bestY) {
      bestY = y;
      picked = el;
    }
  }

  return picked;
}

/**
 * Trigger GeM listing search using the input's nearest "search" button if present.
 * Otherwise fallback to Enter.
 */
async function applyKeywordSearch(page, kw) {
  const bidSearch = await findBidListingKeywordInput(page);
  if (!bidSearch) throw new Error("Could not find Bid Listing keyword input.");

  await bidSearch.waitFor({ state: "visible", timeout: 60000 });
  await bidSearch.scrollIntoViewIfNeeded().catch(() => {});

  // Capture before state
  const prevFirst = await page.locator(".card").first().innerText().catch(() => "");
  const prevCount = await page.locator(".card").count().catch(() => 0);
  const prevHash = await page.evaluate(() => location.hash || "").catch(() => "");

  // Clear + type
  await bidSearch.fill("");
  await bidSearch.type(kw, { delay: 25 });

  // Try to click the correct search button near the input (input-group)
  // This is safer than generic button selectors.
  const searchBtn = bidSearch.locator(
    'xpath=ancestor::div[contains(@class,"input-group")][1]//button | xpath=following-sibling::*[1]//button'
  ).first();

  const btnVisible = await searchBtn.isVisible().catch(() => false);

  if (btnVisible) {
    await searchBtn.click().catch(async () => {
      await bidSearch.press("Enter");
    });
  } else {
    await bidSearch.press("Enter");
  }

  // Don't rely only on "first card changed" (common keywords may keep it same)
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await waitForListingUpdate(page, { prevFirst, prevCount, prevHash });

  const hasCards = await page.locator(".card").count().catch(() => 0);
  return hasCards;
}

/**
 * Find the REAL listing pagination Next.
 * On GeM listing, the "Next" is usually:
 *   <a href="#page-2">Next</a>
 */
async function findListingNextLink(page) {
  // Strict: must be an anchor with text Next AND href starts with #page-
  const next = page.locator('a:has-text("Next")[href^="#page-"]').first();
  if (await next.isVisible().catch(() => false)) return next;

  // Fallback: any anchor whose href is #page-2/#page-3 etc and text "Next"
  const alt = page.locator('a[href^="#page-"]:has-text("Next")').first();
  if (await alt.isVisible().catch(() => false)) return alt;

  return null;
}

/**
 * Scrape GeM listings.
 * If keyword is provided -> uses GeM built-in search (server-side filter).
 * Pagination is hash-based (#page-2), so we click the listing "Next" anchor.
 */
async function scrapeGemListings({ maxPages = 2, keyword = "" } = {}) {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const page = await context.newPage();

  console.log("Opening GeM...");
  await page.goto(GEM_URL, { waitUntil: "domcontentloaded", timeout: 0 });

  // Wait until listing loads
  await page.waitForSelector(".card", { timeout: 60000 });

  // --- Apply keyword (server-side filter) ---
  const kw = String(keyword || "").trim();
  if (kw) {
    console.log(`Applying GeM search keyword: "${kw}"`);

    const count = await applyKeywordSearch(page, kw);

    if (!count) {
      console.log(`No results (0 cards) after searching "${kw}".`);
      await browser.close();

      const file = path.join(__dirname, "data", "tenders.json");
      fs.writeFileSync(file, JSON.stringify([], null, 2));
      console.log("Saved 0 tenders");
      return 0;
    }
  }

  const tenders = [];
  const seen = new Set();

  for (let p = 1; p <= maxPages; p++) {
    console.log(`Reading page ${p}`);

    await page.waitForSelector(".card", { timeout: 60000 });
    const cards = await page.$$(".card");

    for (const card of cards) {
      try {
        const text = await card.innerText();
        const lines = cleanLines(text);

        const bidNo = safeFirst(/GEM\/\d+\/B\/\d+/, text) || "";
        const raNo = safeFirst(/GEM\/\d+\/R\/\d+/, text) || "";

        const links = await card.$$eval("a", (as) =>
          as
            .map((a) => ({
              href: a.getAttribute("href") || "",
              text: (a.textContent || "").trim(),
            }))
            .filter((x) => x.href)
        );

        const normalizedLinks = links.map((l) => ({
          ...l,
          href: l.href.startsWith("http") ? l.href : absUrl(l.href),
        }));

        const listingCandidate =
          normalizedLinks.find((l) => l.href.includes("/bidlists/")) ||
          normalizedLinks.find((l) => l.href.includes("/showbid/")) ||
          normalizedLinks.find((l) => l.href.includes("/bid/")) ||
          normalizedLinks.find((l) => !l.href.includes("/showbidDocument/")) ||
          normalizedLinks[0];

        const docCandidate =
          normalizedLinks.find((l) => l.href.includes("/showbidDocument/")) ||
          normalizedLinks.find((l) => l.href.toLowerCase().includes(".pdf")) ||
          null;

        const listingUrl = listingCandidate ? listingCandidate.href : "";
        const docUrl = docCandidate ? docCandidate.href : "";

        let title = (listingCandidate && listingCandidate.text) || "";
        if (!title) title = lines[0] || "";
        title = String(title || "").trim();

        // Department fix (JEPC was here)
        const deptAddress = valueAfterLabel(lines, "Department Name And Address:");
        const ministryLine =
          lines.find((l) => l.toLowerCase().startsWith("ministry")) || "";
        const department = deptAddress || ministryLine || "";

        const startDate =
          (String(text).match(/Start Date:\s*([^\n]+)/) || [])[1] || "";
        const endDate =
          (String(text).match(/End Date:\s*([^\n]+)/) || [])[1] || "";

        const tender = {
          bidNo,
          raNo,
          title,
          department,
          buyer: "",
          startDate: startDate.trim(),
          endDate: endDate.trim(),
          listingUrl,
          docUrl,
        };

        const key = [bidNo, raNo, listingUrl].join("|");
        if (seen.has(key)) continue;
        seen.add(key);

        tenders.push(tender);
      } catch (e) {
        console.log("Card parse failed");
      }
    }

    // --- Pagination ---
    const nextLink = await findListingNextLink(page);

    if (!nextLink) {
      console.log("No Next button found. Stopping.");
      break;
    }

    const prevFirst = await page.locator(".card").first().innerText().catch(() => "");
    const prevCount = await page.locator(".card").count().catch(() => 0);
    const prevHash = await page.evaluate(() => location.hash || "").catch(() => "");

    await nextLink.scrollIntoViewIfNeeded().catch(() => {});
    await nextLink.click();

    await waitForListingUpdate(page, { prevFirst, prevCount, prevHash });
  }

  await browser.close();

  const file = path.join(__dirname, "data", "tenders.json");
  fs.writeFileSync(file, JSON.stringify(tenders, null, 2));

  console.log(`Saved ${tenders.length} tenders`);
  return tenders.length;
}

module.exports = { scrapeGemListings };
