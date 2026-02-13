const express = require("express");
const { scrapeGemListings } = require("./scraper");

const path = require("path");
const fs = require("fs");

const { matchTenders } = require("./matcher");
const { writeMatchesCsv } = require("./exporter");

const app = express();
const PORT = process.env.PORT || 3000;

// --- middleware ---
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- helpers ---
function readTendersCache() {
  const p = path.join(__dirname, "data", "tenders.json");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// --- routes ---
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});
app.post("/api/fetch", async (req, res) => {
  const pages = Math.max(1, Math.min(Number(req.body.pages || 5), 50));
  const keyword = String(req.body.keyword || "").trim();

  // Always fetch fresh for this endpoint (user explicitly asked)
  console.log(`Fetching tenders from GeM (keyword="${keyword}",pages=${pages})...`);
  await scrapeGemListings({maxPages:pages,keyword});

  const tenders = readTendersCache().map(t => ({
    ...t,
    url:t.listingUrl || t.docUrl || t.url || ""
  }));

  res.json({
    pages,
    keyword,
    totalTendersInCache: tenders.length,
    tenders,
  });
});

app.post("/api/search", async (req, res) => {
  const include = String(req.body.include ?? "");
  const exclude = String(req.body.exclude ?? "");
  const mode = String(req.body.mode ?? "ANY").toUpperCase();

  if (!include.trim()) {
    return res.status(400).json({ error: "Include keywords are required." });
  }

  const tenders = readTendersCache().map(t => ({
    ...t,
    url:t.listingUrl || t.docUrl || t.url || ""
  }));

  const matches = matchTenders(tenders, { include, exclude, mode });
  const csvPath = await writeMatchesCsv(matches);

  res.json({
    totalTendersInCache: tenders.length,
    matchCount: matches.length,
    csvPath,
    matches,
  });
});


app.get("/api/download/all.csv", async (req, res) => {
    const tenders = readTendersCache().map(t => ({
        ...t,
        url:t.listingUrl || t.docUrl || t.url || ""
    }));

  const p = path.join(__dirname, "exports", "all.csv");
  fs.mkdirSync(path.join(__dirname, "exports"), { recursive: true });


  const { createObjectCsvWriter } = require("csv-writer");
  const csvWriter = createObjectCsvWriter({
    path: p,
    header: [
      { id: "bidNo", title: "Bid No" },
      { id: "raNo", title: "RA No" },
      { id: "title", title: "Title" },
      { id: "department", title: "Department" },
      { id: "buyer", title: "Buyer" },
      { id: "startDate", title: "Start Date" },
      { id: "endDate", title: "End Date" },
      { id: "url", title: "Link" }
    ],
  });

  await csvWriter.writeRecords(tenders);
  res.download(p, "all.csv");
});


app.get("/api/download/matches.csv", (req, res) => {
  const p = path.join(__dirname, "exports", "matches.csv");
  if (!fs.existsSync(p)) {
    return res.status(404).send("No CSV generated yet. Run a search first.");
  }
  res.download(p, "matches.csv");
});

// Express 5 safe fallback
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
