// Shared pipeline logic: fetch real data, compute indicators deterministically,
// ask Claude only for narrative text. Runs as a plain Node.js script via GitHub
// Actions (see scripts/run-pipeline.mjs) - no serverless function platform involved.
import * as zapi from "./zapi.mjs";
import { computeIndicators } from "./indicators.mjs";
import { writeNarrative } from "./claude.mjs";

const STRATEGY_BANDS = {
  scalping: { Buy: [1.0, 1.03, 0.98], Hold: [1.0, 1.015, 0.985], Sell: [1.0, 0.97, 1.02] },
  swing: { Buy: [1.0, 1.08, 0.95], Hold: [1.0, 1.04, 0.96], Sell: [1.0, 0.93, 1.06] },
  investment: { Buy: [1.0, 1.20, 0.88], Hold: [1.0, 1.10, 0.90], Sell: [1.0, 0.90, 1.10] },
};

function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

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
      // it just burns time. Give up on it immediately instead.
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

/** The calendar date (YYYY-MM-DD) an ISO timestamp falls on in WIB (UTC+7). */
function wibDateOf(iso) {
  return new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Daily candles for the last ~6 months of trading (~130 sessions) - used for the IHSG
 * chart. One real bar per session (no aggregation) - at this count each candle naturally
 * draws thin and tightly packed, which is exactly what makes a longer-horizon pattern
 * actually readable instead of a handful of sparse, oversized bars.
 */
async function fetchIhsgDailyCandles(symbol, days = 130) {
  const bars = await withRetry(() => zapi.chart({ symbol, count: days, resolution: "1D" }));
  return bars.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close, t: b.date, v: b.volume }));
}

export async function buildDashboard() {
  // ---- 1. Bulk data (Zapi Pro tier: cover the whole exchange, not just a slice) ----
  const [screenerItems, ffPage0, ffPage1, ffPage2, ffPage3, ihsgIndex, ihsgDaily6m] = await Promise.all([
    zapi.screener({ count: 300, sortBy: "volume", sortOrder: "desc" }),
    zapi.idxForeignFlow({ start: 0, length: 200 }),
    zapi.idxForeignFlow({ start: 200, length: 200 }),
    zapi.idxForeignFlow({ start: 400, length: 200 }),
    zapi.idxForeignFlow({ start: 600, length: 200 }),
    zapi.idxIndexSummary(),
    fetchIhsgDailyCandles("IDX:COMPOSITE"),
  ]);
  const ffTop = ffPage0, ffTail = [...ffPage1, ...ffPage2, ...ffPage3];

  const composite = ihsgIndex.find((d) => d.IndexCode === "COMPOSITE");
  const ihsg = {
    level: composite.Close,
    change: composite.Change,
    change_pct: Math.round((composite.Change / composite.Previous) * 10000) / 100,
    prev_close: composite.Previous,
    candles: ihsgDaily6m,
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

  // Real trading-session date this run's data is from, taken from the actual last IHSG daily
  // candle - not whatever day the script happens to execute on. Computed early because the
  // Pluang broker-summary calls below need an explicit date (their default is "today", which
  // is empty on a non-trading day like the deliberate Sunday prep run).
  const lastSessionCandle = ihsg.candles[ihsg.candles.length - 1];
  const sessionDate = lastSessionCandle ? wibDateOf(lastSessionCandle.t) : null;

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
      // Daily history (260 sessions, ~1 year) - used to compute SMA/EMA/RSI/RVOL/pattern plus
      // the 52-week high/low used for Investment's breakout analysis. Must be at least
      // 200 (SMA200 period) + 20 (chart series length) - 1 = 219 sessions, or the SMA200 line
      // on the chart only draws for its last few points instead of the full visible range;
      // 260 leaves comfortable headroom above that floor.
      const candles = await withRetry(() => zapi.chart({ symbol: `IDX:${s.ticker}`, count: 260 }));
      const ind = computeIndicators(candles);
      // Real TradingView technical rating, used to determine verdict/ranking.
      // Never fatal: if this single call fails or the quota is hit, fall back to our
      // own SMA-derived verdict for this ticker only.
      let tv_verdict = null;
      try {
        const tv = await withRetry(() => zapi.technicals({ symbol: `IDX:${s.ticker}` }));
        tv_verdict = tv.summary || null;
      } catch (e) {
        console.error(`technicals(${s.ticker}) unavailable, falling back to computed verdict:`, e.message);
      }
      // Fundamentals: for Investment, these feed the actual screening score (see
      // investmentVerdict below) alongside the technical rating - not just background info.
      // For Scalping/Swing they're shown as background only, never used for their (purely
      // technical) screening. Market cap + PE TTM already came from screener() - no extra
      // call needed for those. Everything else that isn't real from the API is left null and
      // simply omitted on the card, never estimated.
      let fundamentals = { market_cap: s.marketCap ?? null, pe_ttm: round2(s.peRatio) };
      try {
        const fin = await withRetry(() => zapi.financials({ symbol: `IDX:${s.ticker}` }));
        fundamentals.dividend_yield = round2(fin.dividendYieldPercent);
        fundamentals.payout_ratio = round2(fin.dividendPayoutRatioPercent);
        fundamentals.debt_to_equity = round2(fin.debtToEquity);
        fundamentals.roe = round2(fin.returnOnEquityPercent);
        fundamentals.pb_ratio = fin.totalEquity && s.marketCap ? round2(s.marketCap / fin.totalEquity) : null;
      } catch (e) {
        console.error(`financials(${s.ticker}) unavailable, fundamentals limited to market cap/PE:`, e.message);
      }
      return { ...s, ...ind, tv_verdict, cap_tier: capTier(s.marketCap), fundamentals };
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

  // Full 10 Buy / 5 Hold / 5 Sell shortlist (20 tickers), shared across all 3 strategies.
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

  // ---- 5. Top 10 most active brokers for the day (real IDX data via Zapi) - MARKET-WIDE,
  // not tied to any specific stock (verified live that this endpoint has no per-symbol
  // dimension at all). Combined (buy+sell together) - IDX/Zapi doesn't expose a buy vs sell
  // split here, so this ranks brokers by how active they were, not classifies them as net
  // buyers/sellers.
  let activeBrokers = null;
  try {
    const rows = await withRetry(() => zapi.brokerSummary({ length: 100 }));
    const top10 = [...rows]
      .sort((a, b) => b.Value - a.Value)
      .slice(0, 10)
      .map((b) => ({ broker: b.IDFirm, name: b.FirmName, volume: b.Volume, value: b.Value, frequency: b.Frequency }));
    activeBrokers = { date: rows[0] ? rows[0].Date.slice(0, 10) : null, top10 };
  } catch (e) {
    console.error("active broker summary fetch failed, skipping:", e.message);
  }

  // ---- 5b. Each active broker's real top buy pick that day - pure market information, with
  // no connection to our own Buy/Sell recommendations (via Pluang, a genuinely different
  // provider from the market-wide broker-summary above, confirmed live to vary by stock).
  // IDX doesn't publish a "per-broker" report - only "per-stock: top 10 buyer brokers" - so
  // finding each broker's own single biggest stock purchase means scanning stocks and
  // inverting the lookup. Scanning all ~918 listed stocks would burn ~24,000 calls/month on
  // this one feature alone (confirmed via the real account quota: 25,000 calls/month) and
  // risk starving the rest of the pipeline - so this scans the 250 most actively-traded
  // stocks (already sorted by volume from the screener call), which covers the large majority
  // of real market transaction value, at a sustainable ~6,500 calls/month. A broker whose
  // real top pick fell outside this scan window simply gets no pick shown - never guessed.
  const MOST_ACTIVE_SCAN_COUNT = 250;
  const topPickMap = new Map(); // broker code -> { ticker, value, avg_price }
  if (sessionDate) {
    const scanTickers = screenerItems.slice(0, MOST_ACTIVE_SCAN_COUNT);
    const perStockBuyers = await Promise.all(
      scanTickers.map((s) =>
        withRetry(() => zapi.pluangBrokerSummary({ code: s.ticker, date: sessionDate }))
          .then((d) => ({ ticker: s.ticker, buyers: d.buyers || [] }))
          .catch((e) => {
            console.error(`pluangBrokerSummary(${s.ticker}) unavailable, skipping this stock:`, e.message);
            return null;
          })
      )
    );
    for (const stockResult of perStockBuyers) {
      if (!stockResult) continue;
      for (const buyer of stockResult.buyers) {
        const existing = topPickMap.get(buyer.broker);
        if (!existing || buyer.value > existing.value) {
          topPickMap.set(buyer.broker, { ticker: stockResult.ticker, value: buyer.value, avg_price: buyer.averagePrice ?? null });
        }
      }
    }
  }
  if (activeBrokers) {
    activeBrokers.top10 = activeBrokers.top10.map((b) => {
      const pick = topPickMap.get(b.broker);
      return { ...b, top_pick_ticker: pick ? pick.ticker : null, top_pick_avg_price: pick ? pick.avg_price : null };
    });
  }

  // ---- 5c. Fear & Greed sentiment (0-100), real, straight from the provider - only two
  // markets exist here: "stocks" (US equities - the classic CNN-style index, built from
  // US-specific instruments like junk bond spreads and equity put/call ratio, so it can't be
  // reframed as an Indonesia reading) and "crypto" (global, not region-specific). Never
  // fatal - if one or both calls fail, the gauge is simply omitted on the dashboard.
  let marketSentiment = null;
  try {
    const [usStocks, crypto] = await Promise.all([
      withRetry(() => zapi.fearGreedStocks({ count: 1 })),
      withRetry(() => zapi.fearGreedCrypto({ count: 1 })),
    ]);
    marketSentiment = {
      us_stocks: { score: usStocks.score, rating: usStocks.rating, as_of: usStocks.asOf ? usStocks.asOf.slice(0, 10) : null },
      crypto: { score: crypto.score, rating: crypto.rating, as_of: crypto.date || null },
    };
  } catch (e) {
    console.error("fear & greed fetch failed, skipping:", e.message);
  }

  // ---- 5d. Real exchange news + corporate actions (dividend/rights/split) for the Buy list,
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
      tv_verdict: c.tv_verdict,
      lastClose: c.lastClose,
      // Real resistance/support at each strategy's horizon - so the narrative can cite an
      // actual breakout/breakdown level instead of a vague "momentum bagus" line.
      prior20High: c.prior20High, prior20Low: c.prior20Low,
      prior50High: c.prior50High, prior50Low: c.prior50Low,
      yearHigh: c.yearHigh, yearLow: c.yearLow,
    })),
  });

  // ---- 7. Assemble per-strategy recommendation lists (same shortlist, three genuinely
  // different analysis methods and price bands - never the same verdict source reused
  // across strategies with just a different label). Each verdict function only uses
  // real, already-computed fields (RVOL/EMA/RSI/pattern/prior highs-lows/TradingView
  // rating) - nothing here is estimated.

  // Scalping: intraday momentum. A golden cross (EMA13 crossing above EMA21) confirmed by
  // real volume anomaly (RVOL >= 1.5) is the core bullish signal; breaking the prior 20-day
  // high on top of that is the highest-conviction case. Mirrors the death cross + high RVOL
  // + breakdown below the prior low on the sell side.
  function scalpingVerdict(c) {
    const goldenCross = c.ema13 != null && c.ema21 != null && c.ema13 > c.ema21;
    const deathCross = c.ema13 != null && c.ema21 != null && c.ema13 < c.ema21;
    const highRvol = c.rvol != null && c.rvol >= 1.5;
    const breakout = c.prior20High != null && c.lastClose > c.prior20High;
    const breakdown = c.prior20Low != null && c.lastClose < c.prior20Low;
    if (goldenCross && highRvol && breakout) return "Strong Buy";
    if (goldenCross && highRvol) return "Buy";
    if (deathCross && highRvol && breakdown) return "Strong Sell";
    if (deathCross && highRvol) return "Sell";
    return "Hold";
  }

  // Swing: multi-day trend. MA20 above MA50 with price holding above MA20, confirmed by a
  // healthy Higher-High/Higher-Low structure and RSI(14) in a constructive (not overbought/
  // oversold) zone, is the bullish case - a real breakout above the prior 50-session
  // resistance (medium-term, matching Swing's own horizon - longer than Scalping's 20-day)
  // is an alternate trigger on its own and upgrades an already-bullish case to Strong Buy.
  // Mirrors on the bearish side with MA20 below MA50, a Lower-High/Lower-Low structure, and
  // a breakdown below the prior 50-session support.
  function swingVerdict(c) {
    const uptrend = c.sma20 != null && c.sma50 != null && c.sma20 > c.sma50 && c.lastClose > c.sma20;
    const downtrend = c.sma20 != null && c.sma50 != null && c.sma20 < c.sma50 && c.lastClose < c.sma20;
    const healthyPattern = (c.pattern || "").includes("uptrend sehat");
    const downPattern = (c.pattern || "").includes("downtrend");
    const rsiConstructive = c.rsi14 != null && c.rsi14 > 45 && c.rsi14 < 70;
    const breakoutResistance = c.prior50High != null && c.lastClose > c.prior50High;
    const breakdownSupport = c.prior50Low != null && c.lastClose < c.prior50Low;
    if (uptrend && (healthyPattern || breakoutResistance)) return "Strong Buy";
    if (uptrend || (healthyPattern && rsiConstructive) || breakoutResistance) return "Buy";
    if (downtrend && (downPattern || breakdownSupport)) return "Strong Sell";
    if (downtrend || breakdownSupport) return "Sell";
    return "Hold";
  }

  // Investment: long horizon, and genuinely fundamental-driven (not just technical with
  // fundamentals as decoration) - a real screening score that combines three independent,
  // already-real signals: TradingView's own multi-indicator technical rating (base
  // direction), the fundamental composite (quality/valuation gate - can pull a technical Buy
  // back to Hold on weak fundamentals, or lift it to Strong Buy on strong ones), and a real
  // 52-week breakout/breakdown (long-term resistance/support, the timeframe that actually
  // matches a buy-and-hold thesis instead of Scalping/Swing's shorter windows).
  function investmentVerdict(c) {
    let score = 0;
    if (c.tv_verdict) {
      if (c.tv_verdict.includes("strong_buy")) score = 2;
      else if (c.tv_verdict.includes("buy")) score = 1;
      else if (c.tv_verdict.includes("strong_sell")) score = -2;
      else if (c.tv_verdict.includes("sell")) score = -1;
    } else {
      score = c.verdict === "Buy" ? 1 : c.verdict === "Sell" ? -1 : 0;
    }

    const fScore = fundamentalScore(c.fundamentals);
    if (fScore >= 15) score += 1;
    else if (fScore <= -15) score -= 1;

    if (c.yearHigh != null && c.lastClose > c.yearHigh) score += 1;
    if (c.yearLow != null && c.lastClose < c.yearLow) score -= 1;

    if (score >= 3) return "Strong Buy";
    if (score >= 1) return "Buy";
    if (score <= -3) return "Strong Sell";
    if (score <= -1) return "Sell";
    return "Hold";
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

  // "Potensi" - a transparent, bounded (50-90%) confidence heuristic for Buy/Strong Buy
  // calls, built ONLY from the same real signals already used for the verdict above (never
  // a separate guess). It is explicitly NOT a backtested probability - just how strongly
  // this particular stock clears its strategy's own bullish criteria right now. Shown to
  // the user labeled as an estimate, never as a guaranteed number.
  function potentialPct(strategy, c, verdict) {
    if (!verdict.includes("Buy")) return null;
    let score = 55;
    if (strategy === "scalping") {
      if (c.rvol != null) score += Math.max(0, Math.min(15, (c.rvol - 1) * 8));
      if (c.ema13 != null && c.ema21 != null && c.ema21) score += Math.max(-5, Math.min(12, ((c.ema13 - c.ema21) / c.ema21) * 300));
      if (c.prior20High != null && c.lastClose > c.prior20High) score += 8;
    } else if (strategy === "investment") {
      if (c.tv_verdict && c.tv_verdict.includes("strong_buy")) score += 18;
      else if (c.tv_verdict && c.tv_verdict.includes("buy")) score += 9;
      score += Math.max(-8, Math.min(17, fundamentalScore(c.fundamentals) / 3));
      if (c.yearHigh != null && c.lastClose > c.yearHigh) score += 8;
    } else {
      if ((c.pattern || "").includes("uptrend sehat")) score += 12;
      if (c.rsi14 != null && c.rsi14 > 50 && c.rsi14 < 65) score += 10;
      if (c.sma20 != null && c.sma50 != null && c.sma20 > c.sma50) score += 8;
      if (c.prior50High != null && c.lastClose > c.prior50High) score += 8;
    }
    return Math.max(50, Math.min(90, Math.round(score)));
  }

  function buildStrategyList(strategy) {
    const verdictFor = strategy === "scalping" ? scalpingVerdict : strategy === "investment" ? investmentVerdict : swingVerdict;
    const technicalFor = (c) =>
      strategy === "scalping"
        ? `EMA13 ${c.ema13} | EMA21 ${c.ema21} | RVOL ${c.rvol}x | RSI(5) ${c.rsi5} | Resistance 20D ${c.prior20High} | Support 20D ${c.prior20Low}`
        : strategy === "investment"
        ? `SMA50 ${c.sma50} | SMA200 ${c.sma200} | Rating TradingView: ${c.tv_verdict || "N/A"} | Resistance 52W ${c.yearHigh ?? "N/A"} | Support 52W ${c.yearLow ?? "N/A"} | ROE ${c.fundamentals?.roe ?? "N/A"}% | DER ${c.fundamentals?.debt_to_equity ?? "N/A"}`
        : `SMA20 ${c.sma20} | SMA50 ${c.sma50} | RSI(14) ${c.rsi14} | Pola: ${c.pattern} | Resistance 50D ${c.prior50High} | Support 50D ${c.prior50Low}`;
    const sourceFor = strategy === "scalping" ? "TradingView (via Zapi), EMA/RVOL/RSI(5) kami hitung sendiri" : strategy === "investment" ? "TradingView rating + fundamental + IDX resmi" : "TradingView (via Zapi), SMA/RSI(14)/pola kami hitung sendiri";

    const items = withIndicators.map((c) => {
      const verdict = verdictFor(c);
      const band = priceBand(strategy, verdict, c.lastClose);
      const catalyst =
        strategy === "investment"
          ? (narrative.investment_catalysts || {})[c.ticker] || narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan rating TradingView dan fundamental yang tersedia.`
          : narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan ${strategy === "scalping" ? "EMA13/21, RVOL, dan RSI(5)" : "SMA20/50, RSI(14), dan pola HH/HL"}.`;
      return {
        ticker: c.ticker,
        name: c.name,
        cap_tier: c.cap_tier,
        verdict,
        potential_pct: potentialPct(strategy, c, verdict),
        ...band,
        catalyst,
        source: sourceFor,
        technical: technicalFor(c),
        pattern: c.pattern,
        rvol: c.rvol,
        // Chart timeframe matches each strategy's own horizon: Scalping/Swing show the last
        // ~1 month with one real bar per trading day (every session visible, so the pattern
        // is genuinely readable); Investment shows the last ~3 months grouped into real
        // weekly bars. MA/EMA lines line up point-for-point with their chart's own candles.
        candles: strategy === "investment" ? c.candlesWeekly : c.candlesMonth,
        fundamentals: c.fundamentals,
        _sortStrength: strengthScore(verdict),
        _sortFundamental: strategy === "investment" ? fundamentalScore(c.fundamentals) : 0,
        ma_lines:
          strategy === "scalping"
            ? { ema13: c.monthLines.ema13, ema21: c.monthLines.ema21 }
            : strategy === "swing"
            ? { sma20: c.monthLines.sma20, sma50: c.monthLines.sma50 }
            : { sma50: c.chartWeeklyLines.sma50, sma200: c.chartWeeklyLines.sma200 },
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
  // "trading_date" is the date of the actual market session this data is from (computed
  // early as sessionDate, above) - NOT whatever day the script happens to run. This matters
  // because the pipeline now also runs Sunday evening (a deliberate "Monday prep" run on
  // Friday's real closing data): trading_date correctly still says Friday's date, it's never
  // mislabeled as "Sunday's data" just because that's when the job executed.
  const tradingDate = sessionDate || wibNow.toISOString().slice(0, 10);
  const nextUpdate = new Date(wibNow);
  nextUpdate.setUTCDate(nextUpdate.getUTCDate() + 1);
  // Skip Saturday only - the schedule now runs every day except Saturday (Sunday is a
  // deliberate Friday-data prep run for Monday).
  while (nextUpdate.getUTCDay() === 6) {
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
    market_sentiment: marketSentiment,
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
    // Real current price per ticker (from today's screener, ~300 stocks) - not shown in the
    // UI directly. scripts/run-pipeline.mjs uses this to check yesterday's recommendations
    // against what actually happened, for the real (not estimated) win-rate track record.
    price_lookup: Object.fromEntries(screenerItems.map((s) => [s.ticker, s.last])),
  };
}
