// Runs daily after market close (.github/workflows/update-labels.yml, ~17:30 WIB) - the
// "update_labels.py" job from Arsitektur Data & ML Roadmap.pdf §2 Fase 1. Checks every
// pending Buy/Sell call already logged in Supabase's trade_analysis_log against REAL
// subsequent OHLC price history (never estimated) to determine whether Target 1 or the
// stop-loss got hit first, and fills price_h7/price_h30 once that many real trading days
// have actually passed - then upserts the result into trade_labels. See ROADMAP.md §3.5.
import { chart } from "../lib/zapi.mjs";
import { select, upsertRows } from "../lib/supabase.mjs";

const LOOKBACK_DAYS = 35; // 30 (the H30 window) + a few days of buffer for weekends/holidays

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

async function main() {
  const logs = await select("trade_analysis_log", {
    select: "log_id,ticker,timestamp,signal_output,entry_price,target_tp1,target_sl",
    timestamp: `gte.${isoDaysAgo(LOOKBACK_DAYS)}`,
  });
  // Hold entries have no directional target to evaluate against - never logged as labels.
  const directional = logs.filter((r) => /Buy|Sell/.test(r.signal_output || ""));

  const existingLabels = await select("trade_labels", { select: "log_id,is_tp1_hit,is_sl_hit,price_h30" });
  // Once a call has resolved (hit TP1, hit the stop-loss, or reached the full H30 window with
  // neither triggered) its label is final - never recomputed. Anything else (no label row yet,
  // or a label row that's still "open") gets re-checked against today's real price history.
  const resolvedIds = new Set(existingLabels.filter((l) => l.is_tp1_hit || l.is_sl_hit || l.price_h30 != null).map((l) => l.log_id));
  const pending = directional.filter((r) => !resolvedIds.has(r.log_id));

  if (!pending.length) {
    console.log("No pending trade_analysis_log rows need a label update.");
    return;
  }

  const byTicker = new Map();
  for (const row of pending) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  }

  const labelRows = [];
  for (const [ticker, rows] of byTicker) {
    let candles;
    try {
      candles = await chart({ symbol: `IDX:${ticker}`, count: LOOKBACK_DAYS + 10 });
    } catch (e) {
      console.error(`chart(${ticker}) unavailable for label update, skipping this ticker's ${rows.length} pending row(s):`, e.message);
      continue;
    }
    for (const row of rows) {
      const entryDate = row.timestamp.slice(0, 10);
      // Only real trading days strictly AFTER the day this call was logged - never counts the
      // call's own day as "day 1 of the outcome window".
      const future = candles.filter((c) => c.date.slice(0, 10) > entryDate);
      if (future.length === 0) continue; // no trading day has passed yet since the call - check again tomorrow

      const isBuy = row.signal_output.includes("Buy");
      let tp1Hit = false, slHit = false, daysToOutcome = null, maxDrawdownPct = 0;
      for (let i = 0; i < future.length; i++) {
        const bar = future[i];
        // A Sell/Strong Sell call profits when price falls, so its real Target 1 sits BELOW
        // entry and its stop-loss sits ABOVE - the hit tests mirror computeDirectionalLevels'
        // own direction handling in lib/pipeline.mjs, never assume "up = good" for both sides.
        const hitTp = row.target_tp1 != null && (isBuy ? bar.high >= row.target_tp1 : bar.low <= row.target_tp1);
        const hitSl = row.target_sl != null && (isBuy ? bar.low <= row.target_sl : bar.high >= row.target_sl);
        const adversePct = isBuy
          ? ((row.entry_price - bar.low) / row.entry_price) * 100
          : ((bar.high - row.entry_price) / row.entry_price) * 100;
        if (adversePct > maxDrawdownPct) maxDrawdownPct = adversePct;
        // Whichever real level the price actually reaches first wins - if both would be hit
        // on the same bar, the stop-loss is treated as having triggered first (the
        // conservative assumption - a single day's range can't prove which was touched first
        // intraday from daily OHLC alone).
        if (hitSl) { slHit = true; daysToOutcome = i + 1; break; }
        if (hitTp) { tp1Hit = true; daysToOutcome = i + 1; break; }
      }
      const reachedH30 = future.length >= 30;
      if (!tp1Hit && !slHit && !reachedH30) continue; // still open - re-check tomorrow

      labelRows.push({
        log_id: row.log_id,
        price_h7: future[6] ? future[6].close : null,
        price_h30: future[29] ? future[29].close : null,
        is_tp1_hit: tp1Hit,
        is_sl_hit: slHit,
        days_to_outcome: daysToOutcome,
        max_drawdown_pct: Math.round(maxDrawdownPct * 100) / 100,
      });
    }
  }

  if (labelRows.length) {
    await upsertRows("trade_labels", labelRows, "log_id");
    console.log(`Upserted ${labelRows.length} trade_labels row(s).`);
  } else {
    console.log("No trade_labels rows were ready to resolve today.");
  }
}

main().catch((err) => {
  console.error("update-labels failed:", err);
  process.exit(1);
});
