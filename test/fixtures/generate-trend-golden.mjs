// Regenerates trend-golden.json from the CURRENT public/trend.js.
// Run only when trend behavior is intentionally changed:
//   node test/fixtures/generate-trend-golden.mjs
// The committed fixture was captured from upstream commit a616025.
import { writeFileSync } from "node:fs";
import { buildTrendSeries, fitSlope } from "../../public/trend.js";

// Deterministic pseudo-random input: ~120 days, gaps, comment-only days,
// a zero weight, a month boundary and a leap day.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const entries = [];
const start = Date.UTC(2024, 0, 15);
for (let i = 0; i < 120; i++) {
  const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
  const r = rand();
  if (r < 0.15) continue; // missing day
  if (r < 0.20) { entries.push({ date, weight: null, comment: "comment only" }); continue; }
  const weight = Math.round((200 - i * 0.08 + (rand() - 0.5) * 4) * 10) / 10;
  entries.push({ date, weight, comment: r > 0.9 ? "note" : null });
}
entries.push({ date: "2024-05-20", weight: 0, comment: null }); // ignored by trend
const endDate = "2024-05-31";

const series = [...buildTrendSeries(entries, endDate)];
const values = series.map(([, t]) => t);
const slope = fitSlope(values);
writeFileSync(
  new URL("./trend-golden.json", import.meta.url),
  JSON.stringify({ entries, endDate, series, slope }, null, 0) + "\n"
);
console.log(`${series.length} trend days, slope ${slope}`);
