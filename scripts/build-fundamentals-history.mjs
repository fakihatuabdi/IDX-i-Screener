// Converts the IDX fundamentals scraper's raw output (scrapers/idx-fundamentals/data/) into
// docs/data/fundamentals-history.json + fundamentals-status.json - the shape lib/pipeline.mjs
// (real EPS/BVPS for the Investment Max Buy calculation) and the dashboard's Fundamental
// Historis panel actually consume. Runs only from .github/workflows/fundamental-scraper.yml
// (occasional, manual/monthly), never the fast daily update - this data changes once a
// quarter at most, not daily.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const SCRAPER_DATA_DIR = new URL("../scrapers/idx-fundamentals/data/", import.meta.url);
const OUT_DIR = new URL("../docs/data/", import.meta.url);

// This CSV only ever holds plain tickers/numbers (no embedded commas or quoted fields), so a
// straight split is safe and avoids pulling in a CSV parsing dependency for one small file.
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

const PERIOD_ORDER = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };

async function main() {
  const reportsRaw = await readFile(new URL("financial_reports.csv", SCRAPER_DATA_DIR), "utf8");

  const nameByTicker = new Map();
  const byTicker = new Map();
  for (const row of parseCsv(reportsRaw)) {
    if (!PERIOD_ORDER[row.period]) continue;
    if (row.name && !nameByTicker.has(row.ticker)) nameByTicker.set(row.ticker, row.name);
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push({
      year: Number(row.year),
      period: row.period,
      total_assets: toNum(row.total_assets),
      current_assets: toNum(row.current_assets),
      total_liabilities: toNum(row.total_liabilities),
      current_liabilities: toNum(row.current_liabilities),
      total_equity: toNum(row.total_equity),
      revenue: toNum(row.revenue),
      net_income: toNum(row.net_income),
      operating_cash_flow: toNum(row.operating_cash_flow),
      capital_expenditure: toNum(row.capital_expenditure),
      free_cash_flow: toNum(row.free_cash_flow),
      outstanding_shares: toNum(row.outstanding_shares),
    });
  }

  const tickers = {};
  let totalQuarters = 0;
  for (const [ticker, rows] of byTicker.entries()) {
    rows.sort((a, b) => a.year - b.year || PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period]);
    const enriched = rows.map((r) => {
      const shares = r.outstanding_shares;
      const eps = shares > 0 && r.net_income != null ? r.net_income / shares : null;
      const bvps = shares > 0 && r.total_equity != null ? r.total_equity / shares : null;
      const currentRatio = r.current_liabilities > 0 && r.current_assets != null ? r.current_assets / r.current_liabilities : null;
      const debtToEquityReal = r.total_equity > 0 && r.total_liabilities != null ? (r.total_liabilities / r.total_equity) * 100 : null;
      // Same quarter a year earlier - a real YoY comparison, not just "the previous row",
      // which for a ticker with gaps in coverage could be a different quarter entirely. Yahoo
      // only carries ~5-6 quarters at all, so a true year-ago match often simply isn't there.
      const yearAgo = rows.find((p) => p.year === r.year - 1 && p.period === r.period);
      const revenueGrowthYoy = yearAgo?.revenue ? ((r.revenue - yearAgo.revenue) / Math.abs(yearAgo.revenue)) * 100 : null;
      const netIncomeGrowthYoy = yearAgo?.net_income ? ((r.net_income - yearAgo.net_income) / Math.abs(yearAgo.net_income)) * 100 : null;
      return {
        ...r,
        eps: round2(eps),
        bvps: round2(bvps),
        current_ratio: round2(currentRatio),
        debt_to_equity_real: round2(debtToEquityReal),
        revenue_growth_yoy: round2(revenueGrowthYoy),
        net_income_growth_yoy: round2(netIncomeGrowthYoy),
      };
    });
    totalQuarters += enriched.length;
    tickers[ticker] = { name: nameByTicker.get(ticker) || null, quarters: enriched, latest: enriched[enriched.length - 1] || null };
  }

  const generatedAt = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    new URL("fundamentals-history.json", OUT_DIR),
    JSON.stringify({ generated_at: generatedAt, source: "Yahoo Finance (laporan keuangan resmi emiten, ~5-6 kuartal terakhir)", tickers })
  );
  await writeFile(
    new URL("fundamentals-status.json", OUT_DIR),
    JSON.stringify({ generated_at: generatedAt, tickers_covered: Object.keys(tickers).length, total_quarters: totalQuarters })
  );

  console.log(`Wrote fundamentals for ${Object.keys(tickers).length} tickers, ${totalQuarters} quarters total.`);
}

main().catch((err) => {
  console.error("build-fundamentals-history failed:", err);
  process.exit(1);
});
