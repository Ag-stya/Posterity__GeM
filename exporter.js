const path = require("path");
const fs = require("fs");
const { createObjectCsvWriter } = require("csv-writer");

async function writeMatchesCsv(matches) {
  const outDir = path.join(__dirname, "exports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "matches.csv");

  const csvWriter = createObjectCsvWriter({
    path: outPath,
    header: [
      { id: "bidNo", title: "Bid No" },
      { id: "raNo", title: "RA No" },
      { id: "title", title: "Title" },
      { id: "department", title: "Department" },
      { id: "buyer", title: "Buyer" },
      { id: "startDate", title: "Start Date" },
      { id: "endDate", title: "End Date" },
      { id: "url", title: "Link" },
      { id: "matchedKeywordsCsv", title: "Matched Keywords" },
      { id: "score", title: "Score" },
    ],
  });

  const rows = matches.map((m) => ({
    ...m,
    matchedKeywordsCsv: (m.matchedKeywords || []).join("|"),
  }));

  await csvWriter.writeRecords(rows);

  // This is the endpoint your UI hits to download the CSV
  return "/api/download/matches.csv";
}

module.exports = { writeMatchesCsv };
