// Entry point run by the GitHub Actions workflow (.github/workflows/daily-update.yml).
// Builds the dashboard from real data, writes it as a static JSON file the frontend
// fetches directly - no serverless function platform involved at all.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildDashboard } from "../lib/pipeline.mjs";

const OUT_DIR = new URL("../docs/data/", import.meta.url);
const LATEST_PATH = new URL("latest.json", OUT_DIR);

async function loadPreviousHistory() {
  try {
    const raw = await readFile(LATEST_PATH, "utf8");
    const prev = JSON.parse(raw);
    return Array.isArray(prev.history) ? prev.history : [];
  } catch {
    return []; // no previous file yet (first run) - start empty, not an error
  }
}

async function main() {
  const dashboard = await buildDashboard();

  const prevHistory = await loadPreviousHistory();
  const entry = { trading_date: dashboard.meta.trading_date, briefing: dashboard.briefing };
  const history = [entry, ...prevHistory.filter((h) => h.trading_date !== entry.trading_date)].slice(0, 10);

  const output = { ok: true, ...dashboard, history };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(LATEST_PATH, JSON.stringify(output));

  console.log("Dashboard updated OK for", dashboard.meta.trading_date);
}

main().catch((err) => {
  console.error("Pipeline run failed:", err);
  process.exit(1); // non-zero exit fails the GitHub Actions job clearly, with a real log
});
