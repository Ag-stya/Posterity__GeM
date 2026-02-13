function normalizeList(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function haystackText(t) {
  const parts = [
    t.bidNo,
    t.raNo,
    t.title,
    t.department,
    t.buyer,
    t.startDate,
    t.endDate,
    t.url,
  ];

  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchTenders(tenders, { include, exclude, mode }) {
  const includeWords = normalizeList(include);
  const excludeWords = normalizeList(exclude);
  const matchMode = (mode || "ANY").toUpperCase();

  const results = [];

  for (const t of tenders) {
    const text = haystackText(t);

    if (excludeWords.some((w) => w && text.includes(w))) continue;

    const hits = includeWords.filter((w) => w && text.includes(w));
    const ok =
      matchMode === "ALL"
        ? hits.length === includeWords.length
        : hits.length > 0;

    if (!ok) continue;

    results.push({
      ...t,
      matchedKeywords: hits,
      score: hits.length,
    });
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results;
}

module.exports = { matchTenders };
