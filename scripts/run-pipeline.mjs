// Entry point run by the GitHub Actions workflow (.github/workflows/daily-update.yml).
// Builds the dashboard from real data, writes it as a static JSON file the frontend
// fetches directly - no serverless function platform involved at all.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildDashboard } from "../lib/pipeline.mjs";
import { writeWeeklySummary } from "../lib/claude.mjs";
import { insertRows } from "../lib/supabase.mjs";

const OUT_DIR = new URL("../docs/data/", import.meta.url);
const LATEST_PATH = new URL("latest.json", OUT_DIR);
const TRACK_RECORD_PATH = new URL("track-record.json", OUT_DIR);
const FUNDAMENTALS_HISTORY_PATH = new URL("fundamentals-history.json", OUT_DIR);
const FUNDAMENTALS_WATCHLIST_PATH = new URL("../scrapers/idx-fundamentals/data/watchlist.csv", import.meta.url);
const SCALPING_WATCHLIST_PATH = new URL("scalping-watchlist.json", OUT_DIR);
const MAX_TRACK_RECORD_ENTRIES = 300; // keep the file bounded; oldest evaluated entries drop off first
const MAX_PENDING_DAYS = 10; // give up evaluating (mark expired) if a ticker never reappears in the screener
// Start tracking from the next full trading week, not mid-stream, so the win rate is
// fair from day one instead of being seeded by whatever partial data existed already.
const WIN_RATE_START_DATE = "2026-09-14";

async function loadPreviousHistory() {
  try {
    const raw = await readFile(LATEST_PATH, "utf8");
    const prev = JSON.parse(raw);
    return Array.isArray(prev.history) ? prev.history : [];
  } catch {
    return []; // no previous file yet (first run) - start empty, not an error
  }
}

async function loadTrackRecord() {
  try {
    const raw = await readFile(TRACK_RECORD_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // no previous file yet - start empty, not an error
  }
}

// Written occasionally by the separate fundamental-scraper.yml workflow (real IDX XBRL
// filings), not by this run - just read here if it exists. Missing entirely just means
// Investment's Max Buy falls back to its PER/PBV-derived approximation for every ticker.
async function loadFundamentalsHistory() {
  try {
    const raw = await readFile(FUNDAMENTALS_HISTORY_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / (1000 * 60 * 60 * 24);
}

/**
 * Real, verifiable win-rate tracking: every Buy/Strong Buy/Sell/Strong Sell call we made
 * gets recorded with the real price at call time. On every later run, we check the real
 * current price (from today's screener) against that - never estimated, never fabricated.
 * Hold isn't a directional bet, so it's excluded entirely.
 */
function evaluateTrackRecord(trackRecord, priceLookup, todayTradingDate) {
  for (const rec of trackRecord) {
    if (rec.evaluated || rec.trading_date === todayTradingDate) continue;
    const currentPrice = priceLookup[rec.ticker];
    if (currentPrice != null) {
      const isBuy = rec.verdict.includes("Buy");
      rec.evaluated = true;
      rec.evaluated_price = currentPrice;
      rec.evaluated_date = todayTradingDate;
      rec.correct = isBuy ? currentPrice > rec.price_at_call : currentPrice < rec.price_at_call;
    } else if (daysBetween(rec.trading_date, todayTradingDate) > MAX_PENDING_DAYS) {
      // Ticker never reappeared in the screener (illiquid/delisted) - stop waiting on it
      // rather than let it sit pending forever; excluded from the win-rate, not counted
      // as wrong.
      rec.evaluated = true;
      rec.expired = true;
    }
  }
  return trackRecord;
}

function recordTodaysCalls(trackRecord, dashboard) {
  if (dashboard.meta.trading_date < WIN_RATE_START_DATE) return trackRecord; // not started yet
  // The pipeline can run more than once for the same real trading_date (e.g. Friday's own
  // run, then Sunday's prep run reprocessing Friday's data again) - drop any existing
  // unevaluated entries for that date first so re-running never double-records the same
  // calls. Already-evaluated entries for that date are left alone (nothing to redo).
  trackRecord = trackRecord.filter((r) => !(r.trading_date === dashboard.meta.trading_date && !r.evaluated));
  const strategies = ["scalping", "swing", "investment"];
  for (const strategy of strategies) {
    const items = strategy === "swing" ? dashboard.recommendations.swing : dashboard.recommendations[strategy].items;
    for (const item of items) {
      if (!item.verdict.includes("Buy") && !item.verdict.includes("Sell")) continue; // Hold isn't a directional bet
      trackRecord.push({
        trading_date: dashboard.meta.trading_date,
        ticker: item.ticker,
        strategy,
        verdict: item.verdict,
        // The real close price at the moment of the call - not `entry`, which is now a real
        // support/resistance-derived pullback/bounce target that may sit away from that price
        // and might never actually get filled. Win-rate has to measure against the real price
        // we actually had, or a call whose entry never triggers would still count as "correct"
        // just because price drifted up anyway.
        price_at_call: item.last_price,
        evaluated: false,
      });
    }
  }
  return trackRecord;
}

function statsFor(list) {
  const total = list.length;
  const correct = list.filter((r) => r.correct).length;
  return { correct, total, pct: total ? Math.round((correct / total) * 1000) / 10 : null };
}

function computeWinRate(trackRecord) {
  const evaluated = trackRecord.filter((r) => r.evaluated && !r.expired && r.correct != null);
  return {
    overall: statsFor(evaluated),
    scalping: statsFor(evaluated.filter((r) => r.strategy === "scalping")),
    swing: statsFor(evaluated.filter((r) => r.strategy === "swing")),
    investment: statsFor(evaluated.filter((r) => r.strategy === "investment")),
  };
}

/** YYYY-MM-DD of the Monday on/before the given WIB "now" Date. */
function mondayOf(wibNow) {
  const d = new Date(wibNow);
  const day = d.getUTCDay(); // 0=Sun..6=Sat, wibNow's UTC getters already reflect WIB wall-clock
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Friday's run: instead of new recommendations, recap how THIS week's (Monday-Thursday)
 * calls actually did, using only entries already evaluated with real prices.
 */
async function buildWeeklySummary(trackRecord, wibNow) {
  const weekStart = mondayOf(wibNow);
  const weekEntries = trackRecord.filter(
    (r) => r.trading_date >= weekStart && r.trading_date < wibNow.toISOString().slice(0, 10) && r.evaluated && !r.expired && r.correct != null
  );
  const stats = {
    overall: statsFor(weekEntries),
    scalping: statsFor(weekEntries.filter((r) => r.strategy === "scalping")),
    swing: statsFor(weekEntries.filter((r) => r.strategy === "swing")),
    investment: statsFor(weekEntries.filter((r) => r.strategy === "investment")),
  };
  // "Edge": real % move in the direction we called for - positive means the call worked,
  // regardless of whether it was a Buy or a Sell. Ranks how well each call actually did,
  // not just whether it crossed the pass/fail line.
  const withEdge = weekEntries.map((r) => {
    const rawPct = ((r.evaluated_price - r.price_at_call) / r.price_at_call) * 100;
    const edge = r.verdict.includes("Buy") ? rawPct : -rawPct;
    return { ...r, edge: Math.round(edge * 100) / 100 };
  });
  withEdge.sort((a, b) => b.edge - a.edge);
  const bestPick = withEdge[0] || null;
  const worstPick = withEdge[withEdge.length - 1] || null;
  const weekLabel = `${weekStart} s/d ${wibNow.toISOString().slice(0, 10)}`;

  let narrative = { headline: "Belum cukup data untuk rekap minggu ini.", recap: "" };
  if (weekEntries.length > 0) {
    try {
      narrative = await writeWeeklySummary({ weekLabel, stats, bestPick, worstPick });
    } catch (e) {
      console.error("writeWeeklySummary failed, using plain stats without narrative:", e.message);
      narrative = { headline: `Win rate minggu ini: ${stats.overall.pct ?? "N/A"}%`, recap: "" };
    }
  }

  return { week_label: weekLabel, stats, best_pick: bestPick, worst_pick: worstPick, ...narrative };
}

async function main() {
  const fundamentalsHistory = await loadFundamentalsHistory();
  const dashboard = await buildDashboard({ fundamentalsHistory });
  const wibNow = new Date(Date.now() + 7 * 3600 * 1000);
  const isFridayRun = wibNow.getUTCDay() === 5; // wibNow's UTC getters already reflect WIB wall-clock

  const prevHistory = await loadPreviousHistory();
  const entry = { trading_date: dashboard.meta.trading_date, briefing: dashboard.briefing };
  const history = [entry, ...prevHistory.filter((h) => h.trading_date !== entry.trading_date)].slice(0, 10);

  // Real win-rate track record: evaluate yesterday's (and older pending) calls against
  // today's real prices FIRST, then record today's new calls for future evaluation - unless
  // this is Friday's recap run, which deliberately issues no new calls.
  let trackRecord = await loadTrackRecord();
  trackRecord = evaluateTrackRecord(trackRecord, dashboard.price_lookup, dashboard.meta.trading_date);
  if (!isFridayRun) trackRecord = recordTodaysCalls(trackRecord, dashboard);
  // Keep the file bounded: pending entries are always kept (they still need a future run
  // to resolve); if that alone exceeds the cap something is very wrong, but otherwise fill
  // the remaining space with the MOST RECENT evaluated entries, dropping the oldest first.
  const pending = trackRecord.filter((r) => !r.evaluated);
  const evaluated = trackRecord
    .filter((r) => r.evaluated)
    .sort((a, b) => (a.trading_date < b.trading_date ? 1 : -1))
    .slice(0, Math.max(0, MAX_TRACK_RECORD_ENTRIES - pending.length));
  trackRecord = [...pending, ...evaluated];
  const winRate = computeWinRate(trackRecord);

  const weeklySummary = isFridayRun ? await buildWeeklySummary(trackRecord, wibNow) : null;

  // Feature+outcome logging for the ML roadmap (ROADMAP.md §3.5) - never fatal: Supabase being
  // briefly unavailable must not block the dashboard itself from publishing, same resilience
  // rule as every other optional data source in this pipeline. Silently skipped (not an error)
  // if the secrets aren't configured yet - lets this ship ahead of the user finishing Supabase
  // setup without breaking the existing daily run.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const inserted = await insertRows("trade_analysis_log", dashboard.trade_log_rows);
      console.log(`Logged ${inserted.length} rows to Supabase trade_analysis_log.`);
    } catch (e) {
      console.error("Supabase trade_analysis_log insert failed, continuing without it:", e.message);
    }
  }

  const { price_lookup, trade_log_rows, scalping_universe, scalping_universe_names, ...dashboardForOutput } = dashboard; // internal-only, not needed by the frontend
  const output = {
    ok: true,
    ...dashboardForOutput,
    history,
    win_rate: winRate,
    is_weekly_summary_day: isFridayRun,
    weekly_summary: weeklySummary,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(LATEST_PATH, JSON.stringify(output));
  await writeFile(TRACK_RECORD_PATH, JSON.stringify(trackRecord));

  // Keeps the fundamentals scraper's watchlist (scrapers/idx-fundamentals/, a separate Python
  // job - see fundamental-scraper.yml) in sync with the real, current universe of actively-
  // traded IHSG tickers this run's screener actually saw - rather than a hand-typed list that
  // goes stale as tickers get added/delisted/renamed. Real tickers only; never guessed.
  const watchlistTickers = Object.keys(dashboard.price_lookup).sort();
  await writeFile(FUNDAMENTALS_WATCHLIST_PATH, "ticker\n" + watchlistTickers.join("\n") + "\n");

  // Real, current 250-most-active-tickers universe for scalping-scan.mjs (ROADMAP.md §3.4) -
  // re-filtered fresh every day from today's real screener, never a static list.
  await writeFile(SCALPING_WATCHLIST_PATH, JSON.stringify({ generated_at: wibNow.toISOString(), tickers: dashboard.scalping_universe, names: dashboard.scalping_universe_names }));

  // IDX's own official data (index-summary / foreign-flow / broker-summary) was down and
  // buildDashboard() fell back to real, honest substitutes - see data_health in the output
  // (lib/pipeline.mjs) - rather than throwing. This run's output is valid and has already
  // been written above. Deliberately exits 0 even when degraded: the automation itself did
  // its job correctly (a real, honest dashboard got published), so marking the Actions run
  // "failed" here would misrepresent that and needlessly alarm - the dashboard's own
  // data-health banner is the right place to surface "some data is on a fallback source" to
  // whoever's looking, and the hourly recovery-watchdog workflow reads data_health directly
  // from the written file (not this exit code) to decide whether to try again.
  const isDegraded = !dashboard.data_health.all_primary_ok;
  console.log(
    "Dashboard updated for",
    dashboard.meta.trading_date,
    "- win rate:", winRate.overall,
    "- friday recap:", isFridayRun,
    "- data_health:", JSON.stringify(dashboard.data_health)
  );
  if (isDegraded) {
    console.log("Note: at least one source used fallback data instead of real IDX data - see data_health above. The hourly recovery-watchdog will keep trying to get real data back.");
  }
}

main().catch((err) => {
  console.error("Pipeline run failed:", err);
  process.exit(1); // non-zero exit fails the GitHub Actions job clearly, with a real log
});
