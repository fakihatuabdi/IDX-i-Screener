// Shared pipeline logic: fetch real data, compute indicators deterministically,
// ask Claude only for narrative text, and store the result in Netlify Blobs.
// Used by BOTH daily-update.mjs (the 19:00 WIB Scheduled Function, after market close) and
// run-update.mjs (a plain on-demand function for manual testing) - Netlify
// does not allow invoking a schedule()-wrapped function directly over HTTP,
// so the manual-trigger path needs its own thin wrapper around this same logic.
import { getStore } from "@netlify/blobs";
import * as zapi from "./zapi.mjs";
import { computeIndicators } from "./indicators.mjs";
import { writeNarrative } from "./claude.mjs";

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

// Retries a flaky call once after a short delay before giving up - covers transient
// provider hiccups (seen in practice: a momentary "symbol not found" for a perfectly
// valid, liquid ticker like BUMI that succeeds again a moment later).
async function withRetry(fn, { attempts = 4, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // A 404 "symbol not found" is a definitive answer, not a transient hiccup - retrying
      // it just burns time (and, multiplied across a whole shortlist, can push the function
      // past its execution limit). Give up on it immediately instead.
      if (e.status === 404) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
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

/** The trading-day key (YYYY-MM-DD) an ISO timestamp falls on in WIB (UTC+7). */
function wibDateKey(iso) {
  const wib = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return wib.toISOString().slice(0, 10);
}

/**
 * Hourly candles for the LAST trading day only (market open to close, WIB) - used
 * for every chart on the dashboard. Fetches a small window (count=12 hourly bars is
 * comfortably more than one session, ~7 bars) and keeps only the bars that share the
 * most recent bar's calendar date, discarding the earlier day(s) that came along.
 */
async function fetchIntradayCandles(symbol) {
  const bars = await withRetry(() => zapi.chart({ symbol, count: 12, resolution: "60" }));
  if (!bars.length) return [];
  const lastKey = wibDateKey(bars[bars.length - 1].date);
  return bars
    .filter((b) => wibDateKey(b.date) === lastKey)
    .map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close, t: b.date, v: b.volume }));
}

export async function buildDashboard() {
  // ---- 1. Bulk data (Zapi Pro tier: cover the whole exchange, not just a slice) ----
  const [screenerItems, ffPage0, ffPage1, ffPage2, ffPage3, ihsgIndex, ihsgIntraday] = await Promise.all([
    zapi.screener({ count: 300, sortBy: "volume", sortOrder: "desc" }),
    zapi.idxForeignFlow({ start: 0, length: 200 }),
    zapi.idxForeignFlow({ start: 200, length: 200 }),
    zapi.idxForeignFlow({ start: 400, length: 200 }),
    zapi.idxForeignFlow({ start: 600, length: 200 }),
    zapi.idxIndexSummary(),
    fetchIntradayCandles("IDX:COMPOSITE"),
  ]);
  const ffTop = ffPage0, ffTail = [...ffPage1, ...ffPage2, ...ffPage3];

  const composite = ihsgIndex.find((d) => d.IndexCode === "COMPOSITE");
  const ihsg = {
    level: composite.Close,
    change: composite.Change,
    change_pct: Math.round((composite.Change / composite.Previous) * 10000) / 100,
    prev_close: composite.Previous,
    candles: ihsgIntraday,
    // "All Market" totals (all boards combined) - real, straight from IDX's own index-summary
    // row, no extra call needed. A "Regular board only" breakdown was not found from any
    // working endpoint/param, so it's intentionally left out rather than guessed.
    market_stats: {
      lot: Math.round(composite.Volume / 100),
      value: composite.Value,
      frequency: composite.Frequency,
      number_of_stock: composite.NumberOfStock,
    },
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

  // ---- 4. Fetch OHLCV history + compute indicators, one bucket at a time, with automatic
  // backfill: if a candidate's chart data isn't available (delisted symbol, thin/new listing
  // the provider hasn't backfilled, etc.), the next-priority candidate from the same pool
  // takes its place - so the shortlist still ends up with the full 10 Buy / 5 Hold / 5 Sell
  // (20 tickers) instead of silently shrinking. Per the "skip and continue" rule: a bad
  // symbol is replaced, never allowed to abort the whole daily update.
  async function fetchIndicatorsFor(s) {
    try {
      // Daily history (210 sessions) - used to compute SMA/EMA/RSI/RVOL/pattern. Unaffected
      // by the chart display change below; indicators still need real daily history.
      const candles = await withRetry(() => zapi.chart({ symbol: `IDX:${s.ticker}`, count: 210 }));
      const ind = computeIndicators(candles);
      // Real TradingView technical rating, used to gate the Investment strategy below.
      // Never fatal: if this single call fails or the quota is hit, fall back to our
      // own SMA-derived verdict for this ticker only.
      let tv_verdict = null;
      try {
        const tv = await withRetry(() => zapi.technicals({ symbol: `IDX:${s.ticker}` }));
        tv_verdict = tv.summary || null;
      } catch (e) {
        console.error(`technicals(${s.ticker}) unavailable, falling back to computed verdict:`, e.message);
      }
      // Intraday hourly candles for the chart shown on the card - never fatal: fall
      // back to the last 7 daily candles (as a coarser stand-in) if this fails.
      let intradayCandles;
      try {
        intradayCandles = await fetchIntradayCandles(`IDX:${s.ticker}`);
      } catch (e) {
        console.error(`intraday chart(${s.ticker}) unavailable, falling back to daily candles:`, e.message);
        intradayCandles = ind.candles20.slice(-7);
      }
      // Fundamentals: background info only, NEVER used for screening/ranking (that's the
      // technical/flow logic above). Market cap + PE TTM already came from screener() -
      // no extra call needed for those. Everything else that isn't real from the API is
      // left null and simply omitted on the card, never estimated.
      let fundamentals = { market_cap: s.marketCap ?? null, pe_ttm: s.peRatio ?? null };
      try {
        const fin = await withRetry(() => zapi.financials({ symbol: `IDX:${s.ticker}` }));
        fundamentals.dividend_yield = fin.dividendYieldPercent ?? null;
        fundamentals.payout_ratio = fin.dividendPayoutRatioPercent ?? null;
        fundamentals.debt_to_equity = fin.debtToEquity ?? null;
        fundamentals.roe = fin.returnOnEquityPercent ?? null;
        fundamentals.pb_ratio = fin.totalEquity && s.marketCap ? Math.round((s.marketCap / fin.totalEquity) * 100) / 100 : null;
      } catch (e) {
        console.error(`financials(${s.ticker}) unavailable, fundamentals limited to market cap/PE:`, e.message);
      }
      return { ...s, ...ind, tv_verdict, cap_tier: capTier(s.marketCap), intradayCandles, fundamentals };
    } catch (e) {
      console.error(`chart(${s.ticker}) unavailable, replacing with next candidate:`, e.message);
      return null;
    }
  }

  /** Fetches indicators for `pool` in priority order until `targetCount` succeed, or the pool runs out. */
  async function fillBucket(pool, targetCount) {
    const results = [];
    let cursor = 0;
    while (results.length < targetCount && cursor < pool.length) {
      const need = targetCount - results.length;
      const batch = pool.slice(cursor, cursor + need);
      cursor += batch.length;
      const fetched = await Promise.all(batch.filter((c) => !usedTickers.has(c.ticker)).map(fetchIndicatorsFor));
      for (const f of fetched) {
        if (f) {
          results.push(f);
          usedTickers.add(f.ticker);
        }
      }
    }
    return results;
  }

  // Zapi Pro tier: full 10 Buy / 5 Hold / 5 Sell shortlist (20 tickers), shared across all 3 strategies.
  const SHORTLIST_BUY = 10, SHORTLIST_SELL = 5, SHORTLIST_HOLD = 5;
  const usedTickers = new Set();

  const buyPicks = await fillBucket(buySide, SHORTLIST_BUY);

  const holdPool = merged
    .filter((m) => !usedTickers.has(m.ticker) && Math.abs(m.changePercent) < 1.2)
    .sort((a, b) => Math.abs(a.net_value) - Math.abs(b.net_value));
  const holdPicks = await fillBucket(holdPool, SHORTLIST_HOLD);

  const sellPool = sellSide.filter((m) => !usedTickers.has(m.ticker));
  const sellPicks = await fillBucket(sellPool, SHORTLIST_SELL);

  const withIndicators = [...buyPicks, ...holdPicks, ...sellPicks];

  // ---- 5. Top 10 most active brokers (real IDX data via Zapi) on the single biggest net-buy pick.
  // NOTE: IDX/Zapi only exposes combined (buy+sell together) per-broker activity for a stock's
  // session, not a true buy-side vs sell-side split - so this ranks brokers by how active they
  // were (transaction value), not "net buyers vs net sellers".
  let activeBrokers = null;
  try {
    const top = buyPicks[0];
    const brokers = await withRetry(() => zapi.brokerSummary({ symbol: top.ticker, length: 200 }));
    const top10 = [...brokers]
      .sort((a, b) => b.Value - a.Value)
      .slice(0, 10)
      .map((b) => ({
        broker: b.IDFirm,
        name: b.FirmName,
        volume: b.Volume,
        value: b.Value,
        frequency: b.Frequency,
        avg_price: b.Volume ? Math.round(b.Value / b.Volume) : null,
      }));
    activeBrokers = { ticker: top.ticker, date: brokers[0] ? brokers[0].Date.slice(0, 10) : null, top10 };
  } catch (e) {
    console.error("active broker summary fetch failed, skipping:", e.message);
  }

  // ---- 5b. Real exchange news + corporate actions (dividend/rights/split) for the Buy list,
  // straight from IDX. Never fatal - a single failed ticker's corporate-action lookup is
  // skipped, not allowed to blank out the whole section.
  let newsItems = [];
  try {
    const raw = await withRetry(() => zapi.idxNews({ length: 15 }));
    newsItems = raw
      .filter((n) => n.Locale === "id-id")
      .slice(0, 6)
      .map((n) => ({ title: n.Title, source: "IDX", link: null, published_at: n.PublishedDate }));
  } catch (e) {
    console.error("idx news fetch failed, skipping:", e.message);
  }

  const corporateActionResults = await Promise.all(
    buyPicks.map(async (s) => {
      try {
        const items = await withRetry(() => zapi.corporateActions({ code: s.ticker }));
        // Only surface actions with a payment/ex date still in the future - past dividends
        // already paid out aren't a "watch this" catalyst anymore.
        const today = new Date().toISOString().slice(0, 10);
        const upcoming = items.filter((a) => (a.paymentDate || a.exDate || "") >= today);
        if (!upcoming.length) return null;
        const a = upcoming[0];
        const detail =
          a.type === "dividend"
            ? `Dividen tunai Rp${a.cashDividend}/saham - cum date ${a.cumDate}, ex date ${a.exDate}, bayar ${a.paymentDate}`
            : `Corporate action: ${a.type}, tanggal ${a.date}`;
        return { ticker: s.ticker, detail };
      } catch (e) {
        console.error(`corporateActions(${s.ticker}) unavailable, skipping:`, e.message);
        return null;
      }
    })
  );
  const corporateActions = corporateActionResults.filter(Boolean);

  // ---- 6. Ask Claude API to write the narrative layer from these REAL, already-final numbers ----
  const narrative = await writeNarrative({
    ihsg: { level: ihsg.level, change_pct: ihsg.change_pct },
    sectors,
    candidates: withIndicators.map((c) => ({
      ticker: c.ticker,
      verdict: c.verdict,
      changePercent: c.changePercent,
      net_value: c.net_value,
      rsi14: c.rsi14,
      pattern: c.pattern,
      fundamentals: c.fundamentals,
    })),
  });

  // ---- 7. Assemble per-strategy recommendation lists (same shortlist, different price bands/lens) ----
  // Verdict is the REAL TradingView technical rating (5 tiers: Strong Buy/Buy/Hold/Sell/Strong
  // Sell) for every strategy, not just Investment - it's already fetched for all 20 tickers
  // regardless, so there is no reason to fall back to the coarser 3-tier SMA rule unless the
  // technicals() call itself failed for that one ticker.
  function tvVerdictLabel(c) {
    if (c.tv_verdict) {
      if (c.tv_verdict.includes("strong_buy")) return "Strong Buy";
      if (c.tv_verdict.includes("buy")) return "Buy";
      if (c.tv_verdict.includes("strong_sell")) return "Strong Sell";
      if (c.tv_verdict.includes("sell")) return "Sell";
      return "Hold";
    }
    return c.verdict; // fallback: technicals() failed for this ticker, use the SMA-derived verdict
  }

  // Ranking: Strong Buy and Strong Sell are the highest-conviction, most actionable signals -
  // they rank at the top regardless of direction. Hold (no real conviction either way) ranks
  // last. Plain Buy/Sell sit in between.
  function strengthScore(verdict) {
    if (verdict === "Strong Buy" || verdict === "Strong Sell") return 2;
    if (verdict === "Buy" || verdict === "Sell") return 1;
    return 0; // Hold
  }

  // Investment-only tiebreaker: a simple, transparent composite of real fundamental fields
  // (never estimated - a missing field just contributes 0). Higher ROE/dividend yield raise
  // the score; higher PE/debt-to-equity lower it. This only reorders stocks that already
  // share the same technical conviction tier above - it never overrides a Strong Buy/Strong
  // Sell verdict, it just decides who ranks first among equals.
  function fundamentalScore(f) {
    if (!f) return 0;
    let score = 0;
    if (f.roe != null) score += Math.max(-20, Math.min(40, f.roe));
    if (f.dividend_yield != null) score += f.dividend_yield * 2;
    if (f.debt_to_equity != null) score -= f.debt_to_equity * 10;
    if (f.pe_ttm != null && f.pe_ttm > 0) score -= Math.min(f.pe_ttm, 50) * 0.3;
    return score;
  }

  function buildStrategyList(strategy) {
    const items = withIndicators.map((c) => {
      const verdict = tvVerdictLabel(c);
      const band = priceBand(strategy, verdict, c.lastClose);
      const catalyst =
        strategy === "investment"
          ? (narrative.investment_catalysts || {})[c.ticker] || narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan rating TradingView dan fundamental yang tersedia.`
          : narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan SMA50/SMA200 dan aliran asing.`;
      return {
        ticker: c.ticker,
        name: c.name,
        cap_tier: c.cap_tier,
        verdict,
        ...band,
        catalyst,
        source: strategy === "investment" ? "TradingView rating + fundamental + IDX resmi" : "TradingView (via Zapi) + IDX resmi",
        technical: `SMA50 ${c.sma50} | SMA200 ${c.sma200} | RSI(14) ${c.rsi14} | Pola: ${c.pattern}`,
        pattern: c.pattern,
        rvol: c.rvol,
        candles: c.intradayCandles,
        fundamentals: c.fundamentals,
        _sortStrength: strengthScore(verdict),
        _sortFundamental: strategy === "investment" ? fundamentalScore(c.fundamentals) : 0,
        // Real daily-timeframe MA/EMA values (already computed above, no extra cost) -
        // drawn as reference lines on the chart so the intraday session can be read
        // against the stock's actual trend context (which line set is relevant depends
        // on strategy: EMA13/21 for Scalping, SMA20/50 for Swing, SMA50/200 for Investment).
        ma_lines: { sma20: c.sma20, sma50: c.sma50, sma200: c.sma200, ema13: c.ema13, ema21: c.ema21 },
      };
    });

    // Rank by conviction strength (Strong Buy/Strong Sell first, Hold last); for Investment,
    // break ties among same-strength stocks using the fundamental composite score.
    items.sort((a, b) => b._sortStrength - a._sortStrength || b._sortFundamental - a._sortFundamental);
    return items.map((item, i) => {
      const { _sortStrength, _sortFundamental, ...rest } = item;
      return { rank: i + 1, ...rest };
    });
  }

  const now = new Date();
  const wibNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const tradingDate = wibNow.toISOString().slice(0, 10);
  const nextUpdate = new Date(wibNow);
  nextUpdate.setUTCDate(nextUpdate.getUTCDate() + 1);
  // Skip weekends - the scheduled run only fires Mon-Fri, so "next update" should
  // never land on a Saturday/Sunday when today is a Friday (or, in theory, over a
  // long weekend).
  while (nextUpdate.getUTCDay() === 0 || nextUpdate.getUTCDay() === 6) {
    nextUpdate.setUTCDate(nextUpdate.getUTCDate() + 1);
  }
  nextUpdate.setUTCHours(19, 0, 0, 0);

  return {
    meta: {
      trading_date: tradingDate,
      last_updated: wibNow.toISOString().replace("Z", "+07:00"),
      next_update: nextUpdate.toISOString().slice(0, 19) + "+07:00",
    },
    ihsg,
    market_summary: { regime: narrative.regime, summary: narrative.market_summary, sectors },
    tech_news: {
      technical_overview: narrative.technical_overview,
      news: newsItems,
      corporate_actions: corporateActions,
      // "Analyst rating" here is TradingView's own technical rating (real, already fetched
      // above for the Investment strategy) - not a human analyst's target price, which we
      // don't have a real source for. Labeled explicitly so it's never mistaken for one.
      analyst_ratings: buyPicks
        .filter((c) => c.tv_verdict)
        .slice(0, 5)
        .map((c) => ({ ticker: c.ticker, analyst: "TradingView Technical Rating", rating: c.tv_verdict.replace(/_/g, " ") })),
    },
    broker_flow: {
      net_foreign_total: merged.reduce((a, b) => a + b.net_value, 0),
      top_net_buy: buySide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })),
      top_net_sell: sellSide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })),
      active_brokers: activeBrokers,
    },
    recommendations: {
      scalping: { updated_at: wibNow.toISOString(), session_note: "Update harian otomatis - RVOL/EMA13-21/RSI5", items: buildStrategyList("scalping") },
      swing: buildStrategyList("swing"),
      investment: { updated_at: wibNow.toISOString(), items: buildStrategyList("investment") },
    },
    watchouts: sellPicks.slice(0, 3).map((s) => ({ ticker: s.ticker, name: s.name, reason: `Net sell asing terbesar, verdict teknikal Sell.` })),
    briefing: narrative.briefing,
  };
}

/** Runs the full pipeline and persists the result to Netlify Blobs. Shared by both entry points. */
export async function runAndStore() {
  const dashboard = await buildDashboard();
  const store = getStore("ihsg-dashboard");
  await store.setJSON("latest", dashboard);
  await store.setJSON(`history-${dashboard.meta.trading_date}`, { trading_date: dashboard.meta.trading_date, briefing: dashboard.briefing });
  console.log("Dashboard updated OK for", dashboard.meta.trading_date);
  return dashboard;
}
