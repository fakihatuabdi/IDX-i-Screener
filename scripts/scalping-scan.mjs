// Runs every 5 minutes during trading hours (.github/workflows/scalping-scan.yml) - the real
// intraday Scalping scan described in ROADMAP.md §3.4. Two-tier design to fit the Zapi call
// budget while still watching the full real 250-ticker universe:
//   1. Cheap tier: Multi Quote batch (20 codes/call) for ALL 250 tickers every cycle - just
//      enough to rank who's actually moving right now.
//   2. Deep tier: real order book + running-trades (tape reading) for only the ~30 tickers
//      that ranked as biggest movers this cycle - the expensive, high-signal data.
// The 5-minute-granularity intraday chart (for VWAP/EMA/RSI7) is only re-fetched every third
// cycle (~15 min) per the same budget - see isChartCycle below. Values from the last chart
// fetch are reused in between (read back from this script's own previous output), rather than
// silently going stale to null.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as zapi from "../lib/zapi.mjs";
import { sessionVwap, microIndicators, scalpingSignals, verdictFromCounts, primaryVerdict, scalpingLevels, atrDailyBaseline, isAtrElevated, buildCatalyst } from "../lib/scalping.mjs";
import { insertRows } from "../lib/supabase.mjs";

const OUT_DIR = new URL("../docs/data/", import.meta.url);
const WATCHLIST_PATH = new URL("scalping-watchlist.json", OUT_DIR);
const LIVE_PATH = new URL("scalping-live.json", OUT_DIR);
const HOT_COUNT = 30; // deep-tier coverage - see ROADMAP.md §3.4 for the quota math behind this number
const MULTIQUOTE_BATCH = 20; // Pluang's own per-call cap

async function loadWatchlist() {
  try {
    const raw = await readFile(WATCHLIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { tickers: parsed.tickers || [], names: parsed.names || {} };
  } catch {
    return { tickers: [], names: {} }; // not written yet (daily pipeline hasn't run since this feature shipped) - nothing to scan today
  }
}

async function loadPrevious() {
  try {
    const raw = await readFile(LIVE_PATH, "utf8");
    const prev = JSON.parse(raw);
    return new Map((prev.items || []).map((it) => [it.ticker, it]));
  } catch {
    return new Map();
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function main() {
  const { tickers, names } = await loadWatchlist();
  if (!tickers.length) {
    console.log("No scalping watchlist yet (docs/data/scalping-watchlist.json missing) - nothing to scan.");
    return;
  }
  const previous = await loadPrevious();
  const isChartCycle = new Date().getUTCMinutes() % 15 === 0;
  const todayWib = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  // WIB wall-clock hour at run time - outside the real 09:00-16:00 WIB trading window (the
  // scalping-scan.yml pre-market cron entry runs at 19:00 WIB the evening BEFORE, not right
  // before the open - see that file's comment for why), real fresh intraday chart/running-
  // trades data genuinely doesn't exist yet; the chart-cycle fallback above already handles
  // that gracefully by reusing the last real cached values rather than fabricating anything -
  // this flag is only used to label the output honestly, never to change what gets computed.
  const wibHour = new Date(Date.now() + 7 * 3600 * 1000).getUTCHours();
  const sessionPhase = wibHour >= 9 && wibHour < 16 ? "live" : "pre_market";

  // ---- Tier 1: cheap, whole-universe price/volume screening ----
  const quoteItems = [];
  for (const batch of chunk(tickers, MULTIQUOTE_BATCH)) {
    try {
      const res = await withRetry(() => zapi.pluangMultiQuote({ codes: batch }));
      quoteItems.push(...(res.items || []));
    } catch (e) {
      console.error(`pluangMultiQuote batch failed (${batch.length} tickers), skipping this batch:`, e.message);
    }
  }
  const withChange = quoteItems
    .filter((q) => q.previousClose > 0 && q.lastPrice != null)
    .map((q) => ({ ...q, changePct: ((q.lastPrice - q.previousClose) / q.previousClose) * 100 }));
  const hot = [...withChange].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, HOT_COUNT);

  // ---- Tier 2: deep scan (order book + tape reading, + chart on chart cycles) for the hot subset ----
  const items = await Promise.all(
    hot.map(async (q) => {
      const prev = previous.get(q.code);
      let vwap = prev?.vwap ?? null, ema3 = prev?.ema3 ?? null, ema5 = prev?.ema5 ?? null, ema9 = prev?.ema9 ?? null, rsi7 = prev?.rsi7 ?? null;
      let chartUpdatedAt = prev?.chart_updated_at ?? null;
      let atr5dAvg = prev?.atr5d_avg ?? null;
      let atrBaselineDate = prev?.atr_baseline_date ?? null;
      let atrElevated = prev?.atr_elevated ?? null;
      // Persisted for display (see the return object below) even on cycles that don't refetch
      // the chart - lastBar itself (open/close, needed fresh for volBull/volBear's direction
      // check) is NOT cached, only its real volume number and the MA20 baseline are.
      let lastBarVolume = prev?.last_bar_volume ?? null;
      let avgBarVolume = prev?.avg_bar_volume ?? null;
      let lastBar = null;

      // Daily ATR(14) 5-day baseline (Spesifikasi Algorithmic Trading & ML.pdf §1.1, see
      // lib/scalping.mjs atrDailyBaseline) - only needs refreshing once per real trading day,
      // not every 5-minute cycle, so it's cached the same way VWAP/EMA are across cycles.
      if (atrBaselineDate !== todayWib) {
        try {
          const daily = await withRetry(() => zapi.chart({ symbol: `IDX:${q.code}`, count: 25 }));
          atr5dAvg = atrDailyBaseline(daily);
          atrBaselineDate = todayWib;
        } catch (e) {
          console.error(`daily chart(${q.code}) unavailable for ATR baseline this cycle, reusing cached value if any:`, e.message);
        }
      }

      if (isChartCycle || vwap == null) {
        try {
          const chartRes = await withRetry(() => zapi.pluangChart({ code: q.code }));
          const bars = chartRes.items || [];
          if (bars.length) {
            vwap = sessionVwap(bars);
            const micro = microIndicators(bars);
            ema3 = micro.ema3; ema5 = micro.ema5; ema9 = micro.ema9; rsi7 = micro.rsi7;
            lastBar = bars[bars.length - 1];
            lastBarVolume = lastBar.volume;
            // MA_Vol_20 (Buku Putih §2A) - real average of the last 20 prior 5-minute bars
            // (or fewer early in the session, when 20 don't exist yet), not every bar since
            // the open - a genuine moving-average baseline, not a session-long average that
            // would keep growing stiffer as the day goes on.
            const priorBars = bars.slice(0, -1).slice(-20);
            avgBarVolume = priorBars.length ? priorBars.reduce((a, b) => a + (b.volume || 0), 0) / priorBars.length : null;
            atrElevated = isAtrElevated(bars, atr5dAvg);
            chartUpdatedAt = new Date().toISOString();
          }
        } catch (e) {
          console.error(`pluangChart(${q.code}) unavailable this cycle, reusing cached VWAP/EMA/RSI if any:`, e.message);
        }
      }

      let bidPercent = null, buyLots = null, sellLots = null;
      try {
        const [ob, trades] = await Promise.all([
          withRetry(() => zapi.pluangOrderBook({ code: q.code })),
          withRetry(() => zapi.pluangRunningTrades({ code: q.code })),
        ]);
        bidPercent = ob.bidPercent ?? null;
        buyLots = (trades.items || []).filter((t) => t.action === "BUY").reduce((a, t) => a + (t.lots || 0), 0);
        sellLots = (trades.items || []).filter((t) => t.action === "SELL").reduce((a, t) => a + (t.lots || 0), 0);
      } catch (e) {
        console.error(`orderbook/running-trades(${q.code}) unavailable this cycle:`, e.message);
      }

      const { bull, bear, flags } = scalpingSignals({
        lastPrice: q.lastPrice, vwap, ema3, ema5, ema9, rsi7, lastBar, avgBarVolume, bidPercent, buyLots, sellLots,
      });
      // Volume Breakout evaluated from the CACHED volume numbers (persist every cycle, not
      // just chart-refresh cycles - see lastBarVolume/avgBarVolume above) so the Entry rule
      // below can react every 5 minutes, not just every ~15-minute chart cycle.
      const volumeBreakoutNow = lastBarVolume != null && avgBarVolume != null && avgBarVolume > 0 && lastBarVolume > avgBarVolume * 1.5;
      // PRIMARY verdict: Buku Putih §2B's literal Entry AND-rule (see lib/scalping.mjs
      // primaryVerdict) - the generic 6-signal matrix (verdictFromCounts) is now only
      // secondary/informational (verdict_b), same "parallel, not authoritative" treatment
      // already used for Swing/Investment.
      const { verdict, isAboveVwap } = primaryVerdict({
        lastPrice: q.lastPrice, vwap, wasAboveVwap: prev?.is_above_vwap ?? null,
        volumeBreakout: volumeBreakoutNow, buyLots, sellLots, bull, bear,
      });
      const verdictB = verdictFromCounts(bull, bear);
      const levels = scalpingLevels(verdict, q.lastPrice);
      const catalyst = buildCatalyst({ ticker: q.code, verdict, flags, rsi7, bidPercent, atrElevated });

      return {
        ticker: q.code,
        name: names[q.code] || null,
        last_price: q.lastPrice,
        change_pct: Math.round(q.changePct * 100) / 100,
        verdict, bull, bear, flags,
        // Experimental, informational only - see docs/index.html's "Alt" badge pattern for
        // Swing/Investment. Never used for ranking/Entry/Target/Stop-Loss.
        verdict_b: verdictB,
        // Within each Buy/Hold/Sell group on the dashboard (docs/index.html's
        // renderGroupedByVerdict sorts by this exact field, same as Swing/Investment) -
        // Strong Buy/Strong Sell (highest conviction) always shown before plain Buy/Sell.
        rank: verdict === "Strong Buy" || verdict === "Strong Sell" ? 1 : verdict === "Buy" || verdict === "Sell" ? 2 : 3,
        catalyst,
        vwap: vwap != null ? Math.round(vwap) : null,
        is_above_vwap: isAboveVwap,
        ema3, ema5, ema9, rsi7,
        bid_percent: bidPercent,
        buy_lots: buyLots, sell_lots: sellLots,
        last_bar_volume: lastBarVolume, avg_bar_volume: avgBarVolume != null ? Math.round(avgBarVolume) : null,
        volume_breakout: volumeBreakoutNow,
        // Volatility context (not a bull/bear vote - see lib/scalping.mjs isAtrElevated).
        atr5d_avg: atr5dAvg, atr_baseline_date: atrBaselineDate, atr_elevated: atrElevated,
        chart_updated_at: chartUpdatedAt,
        ...levels,
      };
    })
  );

  // ---- Signal-change logging to Supabase (only on a NEW signal, never every cycle - see
  // ROADMAP.md §3.5 for why: logging every cycle for every scanned ticker would blow past
  // Supabase's free-tier storage in weeks, not years) ----
  const changedRows = items
    .filter((it) => it.verdict !== "Hold" && it.verdict !== (previous.get(it.ticker)?.verdict ?? "Hold"))
    .map((it) => ({
      ticker: it.ticker,
      timeframe_type: "Scalping",
      trend_ihsg: null,
      feat_rsi_value: it.rsi7,
      feat_macd_hist: null,
      feat_price_vs_sma20: null,
      feat_vol_vs_avg20: null,
      feat_pbv: null,
      feat_per: null,
      feat_der: null,
      feat_roe: null,
      score_confluence: it.bull - it.bear,
      signal_output: it.verdict,
      entry_price: it.entry,
      target_tp1: it.target1,
      target_sl: it.stop_loss,
    }));
  if (changedRows.length && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      await insertRows("trade_analysis_log", changedRows);
      console.log(`Logged ${changedRows.length} new scalping signal(s) to Supabase.`);
    } catch (e) {
      console.error("Supabase trade_analysis_log insert failed, continuing without it:", e.message);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    LIVE_PATH,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      session_phase: sessionPhase,
      universe_count: tickers.length,
      hot_count: items.length,
      is_chart_cycle: isChartCycle,
      items,
    })
  );
  console.log(`Scalping scan done: ${tickers.length} tickers screened, ${items.length} scanned deep, ${changedRows.length} new signal(s).`);
}

main().catch((err) => {
  console.error("scalping-scan failed:", err);
  process.exit(1);
});
