// Netlify Scheduled Function - runs automatically on the cron below (UTC!).
// 08:00 WIB = 01:00 UTC -> "0 1 * * *"
import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import * as zapi from "./lib/zapi.mjs";
import * as arjum from "./lib/arjum.mjs";
import { computeIndicators } from "./lib/indicators.mjs";
import { writeNarrative } from "./lib/claude.mjs";

const STRATEGY_BANDS = {
  scalping: { Buy: [1.0, 1.03, 0.98], Hold: [1.0, 1.015, 0.985], Sell: [1.0, 0.97, 1.02] },
  swing: { Buy: [1.0, 1.08, 0.95], Hold: [1.0, 1.04, 0.96], Sell: [1.0, 0.93, 1.06] },
  investment: { Buy: [1.0, 1.20, 0.88], Hold: [1.0, 1.10, 0.90], Sell: [1.0, 0.90, 1.10] },
};

function capTier(marketCap) {
  if (marketCap == null) return null;
  if (marketCap >= 55e12) return "Big Cap";
  if (marketCap >= 7e12) return "Mid Cap";
  return "Small Cap";
}

function priceBand(strategy, verdict, lastClose) {
  const key = verdict === "Sell" || verdict === "Strong Sell" ? "Sell" : verdict === "Hold" ? "Hold" : "Buy";
  const [em, tm, sm] = STRATEGY_BANDS[strategy][key];
  return {
    entry: Math.round(lastClose * em),
    target: Math.round(lastClose * tm),
    stop_loss: Math.round(lastClose * sm),
  };
}

async function buildDashboard() {
  // ---- 1. Bulk data (Zapi Pro tier: cover the whole exchange, not just a slice) ----
  const [screenerItems, ffPage0, ffPage1, ffPage2, ffPage3, ihsgIndex, ihsgChartRaw] = await Promise.all([
    zapi.screener({ count: 300, sortBy: "volume", sortOrder: "desc" }),
    zapi.idxForeignFlow({ start: 0, length: 200 }),
    zapi.idxForeignFlow({ start: 200, length: 200 }),
    zapi.idxForeignFlow({ start: 400, length: 200 }),
    zapi.idxForeignFlow({ start: 600, length: 200 }),
    zapi.idxIndexSummary(),
    zapi.chart({ symbol: "IDX:COMPOSITE", count: 25 }),
  ]);
  const ffTop = ffPage0, ffTail = [...ffPage1, ...ffPage2, ...ffPage3];

  const composite = ihsgIndex.data.find((d) => d.IndexCode === "COMPOSITE");
  const ihsg = {
    level: composite.Close,
    change: composite.Change,
    change_pct: Math.round((composite.Change / composite.Previous) * 10000) / 100,
    prev_close: composite.Previous,
    candles: ihsgChartRaw.slice(-25).map((c) => ({ o: Math.round(c.open * 10) / 10, h: Math.round(c.high * 10) / 10, l: Math.round(c.low * 10) / 10, c: Math.round(c.close * 10) / 10 })),
  };

  // ---- 2. Sector aggregates (real, deterministic - not sampled) ----
  const bySector = {};
  for (const it of screenerItems) {
    if (!it.sector) continue;
    (bySector[it.sector] ||= []).push(it.changePercent);
  }
  const sectors = Object.entries(bySector)
    .filter(([, arr]) => arr.length >= 3)
    .map(([name, arr]) => ({ name, change_pct: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 }))
    .sort((a, b) => b.change_pct - a.change_pct);

  // ---- 3. Merge screener + foreign flow, rank candidates (deterministic, no AI) ----
  const screenerByTicker = Object.fromEntries(screenerItems.map((s) => [s.ticker, s]));
  const ffAll = [...ffTop, ...ffTail].map((f) => ({
    ticker: f.code,
    name: f.name,
    net_value: Math.round(f.netForeignShares * f.close),
  }));
  const merged = ffAll
    .filter((f) => screenerByTicker[f.ticker])
    .map((f) => ({ ...f, ...screenerByTicker[f.ticker] }));

  const buySide = [...merged].sort((a, b) => b.net_value - a.net_value);
  const sellSide = [...merged].sort((a, b) => a.net_value - b.net_value);

  // Zapi Pro tier: full 10 Buy / 5 Hold / 5 Sell shortlist (20 tickers), shared across all 3 strategies.
  const SHORTLIST_BUY = 10, SHORTLIST_SELL = 5, SHORTLIST_HOLD = 5;
  const buyPicks = buySide.slice(0, SHORTLIST_BUY);
  const sellPicks = sellSide.slice(0, SHORTLIST_SELL);
  const usedTickers = new Set([...buyPicks, ...sellPicks].map((x) => x.ticker));
  const holdPool = merged
    .filter((m) => !usedTickers.has(m.ticker) && Math.abs(m.changePercent) < 1.2)
    .sort((a, b) => Math.abs(a.net_value) - Math.abs(b.net_value));
  const holdPicks = holdPool.slice(0, SHORTLIST_HOLD);

  const shortlist = [...buyPicks, ...holdPicks, ...sellPicks];

  // ---- 4. Fetch OHLCV history + compute indicators for the shortlist (20 tickers - well within Pro quota) ----
  const withIndicators = await Promise.all(
    shortlist.map(async (s) => {
      const candles = await zapi.chart({ symbol: `IDX:${s.ticker}`, count: 210 });
      const ind = computeIndicators(candles);
      // Real TradingView technical rating, used to gate the Investment strategy below.
      // Never fatal: if this single call fails or the quota is hit, skip and fall back
      // to our own SMA-derived verdict for this ticker only (per the "skip and continue" rule).
      let tv_verdict = null;
      try {
        const tv = await zapi.technicals({ symbol: `IDX:${s.ticker}` });
        tv_verdict = tv.summary || null;
      } catch (e) {
        console.error(`technicals(${s.ticker}) failed, falling back to computed verdict:`, e.message);
      }
      return { ...s, ...ind, tv_verdict, cap_tier: capTier(s.marketCap) };
    })
  );

  // ---- 5. Broker/bandarmology highlight on the single biggest net-buy pick ----
  let bandarmology = null;
  try {
    const top = buyPicks[0];
    const brokers = await arjum.brokerSummary(top.ticker);
    const sorted = [...brokers].sort((a, b) => b.nval - a.nval);
    bandarmology = {
      ticker: top.ticker,
      top_buyers: sorted.slice(0, 3).map((b) => ({ broker: b.broker_code, value: (b.nval / 1e9).toFixed(2) + "B" })),
      top_sellers: sorted.slice(-3).reverse().map((b) => ({ broker: b.broker_code, value: (b.nval / 1e9).toFixed(2) + "B" })),
    };
  } catch (e) {
    console.error("bandarmology fetch failed, skipping:", e.message);
  }

  // ---- 6. Ask Claude API to write the narrative layer from these REAL, already-final numbers ----
  const narrative = await writeNarrative({
    ihsg: { level: ihsg.level, change_pct: ihsg.change_pct },
    sectors,
    candidates: withIndicators.map((c) => ({ ticker: c.ticker, verdict: c.verdict, changePercent: c.changePercent, net_value: c.net_value, rsi14: c.rsi14, pattern: c.pattern })),
  });

  // ---- 7. Assemble per-strategy recommendation lists (same shortlist, different price bands/lens) ----
  // Investment specifically requires TradingView's own verdict to be Buy/Strong Buy - a blue chip
  // with a real Sell/Neutral rating is never forced into the Buy bucket just for being a blue chip.
  function investmentVerdict(c) {
    if (c.tv_verdict) {
      if (c.tv_verdict.includes("strong_buy")) return "Strong Buy";
      if (c.tv_verdict.includes("buy")) return "Buy";
      if (c.tv_verdict.includes("sell")) return "Sell";
      return "Hold";
    }
    return c.verdict; // fallback: technicals() failed for this ticker, use the SMA-derived verdict
  }

  function buildStrategyList(strategy) {
    return withIndicators.map((c, i) => {
      const verdict = strategy === "investment" ? investmentVerdict(c) : c.verdict;
      const band = priceBand(strategy, verdict, c.lastClose);
      return {
        rank: i + 1,
        ticker: c.ticker,
        name: c.name,
        cap_tier: c.cap_tier,
        verdict,
        ...band,
        catalyst: narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan SMA50/SMA200 dan aliran asing.`,
        source: strategy === "investment" ? "TradingView rating + IDX resmi" : "TradingView (via Zapi) + IDX resmi",
        technical: `SMA50 ${c.sma50} | SMA200 ${c.sma200} | RSI(14) ${c.rsi14} | Pola: ${c.pattern}`,
        pattern: c.pattern,
        rvol: c.rvol,
        candles: c.candles20,
      };
    });
  }

  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const tradingDate = wibNow.toISOString().slice(0, 10);
  const nextUpdate = new Date(wibNow);
  nextUpdate.setUTCDate(nextUpdate.getUTCDate() + 1);
  nextUpdate.setUTCHours(8, 0, 0, 0);

  const dashboard = {
    meta: {
      trading_date: tradingDate,
      last_updated: wibNow.toISOString().replace("Z", "+07:00"),
      next_update: nextUpdate.toISOString().slice(0, 19) + "+07:00",
    },
    ihsg,
    market_summary: { regime: narrative.regime, summary: narrative.market_summary, sectors },
    tech_news: { technical_overview: narrative.technical_overview, news: [], corporate_actions: [], analyst_ratings: [] },
    broker_flow: {
      net_foreign_total: merged.reduce((a, b) => a + b.net_value, 0),
      top_net_buy: buySide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })),
      top_net_sell: sellSide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })),
      bandarmology,
    },
    recommendations: {
      scalping: { updated_at: wibNow.toISOString(), session_note: "Update harian otomatis - RVOL/EMA13-21/RSI5", items: buildStrategyList("scalping") },
      swing: buildStrategyList("swing"),
      investment: { updated_at: wibNow.toISOString(), items: buildStrategyList("investment") },
    },
    watchouts: sellPicks.slice(0, 3).map((s) => ({ ticker: s.ticker, name: s.name, reason: `Net sell asing terbesar, verdict teknikal Sell.` })),
    briefing: narrative.briefing,
  };

  return dashboard;
}

async function handler(req) {
  try {
    const dashboard = await buildDashboard();
    const store = getStore("ihsg-dashboard");
    await store.setJSON("latest", dashboard);
    await store.setJSON(`history-${dashboard.meta.trading_date}`, { trading_date: dashboard.meta.trading_date, briefing: dashboard.briefing });
    console.log("Dashboard updated OK for", dashboard.meta.trading_date);
    return new Response(JSON.stringify({ ok: true, trading_date: dashboard.meta.trading_date }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("daily-update failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

// Runs automatically at 01:00 UTC = 08:00 WIB every day.
// Netlify also lets you trigger this manually via /api/run-update for testing.
export default schedule("0 1 * * *", handler);
