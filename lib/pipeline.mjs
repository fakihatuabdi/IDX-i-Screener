// Shared pipeline logic: fetch real data, compute indicators deterministically,
// ask Claude only for narrative text. Runs as a plain Node.js script via GitHub
// Actions (see scripts/run-pipeline.mjs) - no serverless function platform involved.
import * as zapi from "./zapi.mjs";
import { computeIndicators } from "./indicators.mjs";
import { writeNarrative } from "./claude.mjs";

// Entry/target/stop-loss are derived from real technical structure, not a flat % of last
// close. Scalping/Swing entry is a real accumulation ZONE anchored to the support/resistance
// level that matches each strategy's own timeframe (Scalping: EMA9/prior 20D high-low, Swing:
// SMA20/prior 50D high-low) - the zone can sit ABOVE today's close when price is approaching
// or has just cleared its own resistance (a genuine breakout/momentum entry, not just "buy the
// dip"), see computeDirectionalLevels. Investment instead gets a single fundamental-led "Max
// Buy" ceiling (Graham Number fair value with a margin of safety), see computeInvestmentLevels.
// Stop-loss in both is sized off that stock's own real ATR(14), nudged past a genuine nearby
// structural swing low/high when that real level sits tighter than the ATR stop. Target1 is a
// reward:risk multiple of that same real risk distance; Target2 extends further - to a real
// further structural level (52-week high/low) when one genuinely sits beyond Target1, otherwise
// a wider reward:risk multiple of the same risk. Nothing here is an arbitrary fixed percentage.
const RISK_CONFIG = {
  scalping: { supportKey: "ema9", stopAtrMult: 1.0, rr1: 1.5, rr2: 2.5, maxAtrMult: 0.6, narrowAtrMult: 0.2, breakoutBufferAtrMult: 0.15, structKey: "prior20" },
  swing: { supportKey: "sma20", stopAtrMult: 1.5, rr1: 2.0, rr2: 3.2, maxAtrMult: 1.2, narrowAtrMult: 0.4, breakoutBufferAtrMult: 0.25, structKey: "prior50" },
  investment: { supportKey: "sma50", stopAtrMult: 2.0, rr1: 2.5, rr2: 4.0, maxAtrMult: 2.5, narrowAtrMult: 0.8, structKey: "year" },
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
async function withRetry(fn, { attempts = 3, delayMs = 400 } = {}) {
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

/** Target2: the next real objective beyond Target1 - a genuine further structural level
 * (52-week high/low) when one actually sits between Target1 and the extended reward:risk
 * projection, otherwise the extended RR projection itself. `farLevel` is that stock's own
 * yearHigh/yearLow (the only "further out" real level we have beyond each strategy's own
 * near-term structure). */
function extendTarget(cfg, base, risk, isSell, farLevel) {
  const rr2Level = isSell ? base - (cfg.rr2 - cfg.rr1) * risk : base + (cfg.rr2 - cfg.rr1) * risk;
  if (farLevel != null) {
    if (!isSell && farLevel > base && farLevel < rr2Level) return farLevel;
    if (isSell && farLevel < base && farLevel > rr2Level) return farLevel;
  }
  return rr2Level;
}

/** Scalping & Swing: real technical entry zone (can sit above today's close - see below),
 * Target1/Target2, and stop-loss - all sized off this stock's own real ATR(14) and structure. */
function computeDirectionalLevels(strategy, verdict, c) {
  const cfg = RISK_CONFIG[strategy];
  const lastClose = c.lastClose;
  // Freshly-listed stocks without 14 real sessions yet have no ATR - fall back to a
  // conservative flat 1.5% of price until real ATR warms up (never used once it has).
  const atr = c.atr14 != null && c.atr14 > 0 ? c.atr14 : lastClose * 0.015;
  const structLow = c[cfg.structKey + "Low"];
  const structHigh = c[cfg.structKey + "High"];

  if (verdict === "Hold") {
    // Hold isn't a directional bet, so no entry zone applies - just target/stop-loss sized
    // off a tighter slice of this strategy's own real ATR risk (this stock's actual daily
    // volatility, not one flat percentage applied to every ticker alike).
    const band = cfg.stopAtrMult * atr * 0.6;
    return {
      entry_low: null, entry_high: null, max_buy: null,
      target1: Math.round(lastClose + band), target2: Math.round(lastClose + band * 1.6),
      stop_loss: Math.round(lastClose - band),
    };
  }

  if (verdict === "Sell" || verdict === "Strong Sell") {
    // A Sell call means act now - exit or short at today's real close (already shown
    // separately as "Harga Terakhir") - so there's no separate entry zone to project, only
    // how far a real ATR-sized stop and reward:risk targets sit from that real price.
    const stopDistance = cfg.stopAtrMult * atr;
    let stopLoss = lastClose + stopDistance;
    if (structHigh != null && structHigh > stopLoss && structHigh - stopLoss <= stopDistance) {
      stopLoss = structHigh * 1.005;
    }
    const risk = stopLoss - lastClose;
    const target1 = lastClose - cfg.rr1 * risk;
    const target2 = extendTarget(cfg, target1, risk, true, c.yearLow);
    return { entry_low: null, entry_high: null, max_buy: null, target1: Math.round(target1), target2: Math.round(target2), stop_loss: Math.round(stopLoss) };
  }

  // Buy/Strong Buy - three classical technical entry archetypes, tried in priority order, with
  // NO cap at today's close (a real breakout order legitimately buys higher than the current
  // price - that's the whole point of one):
  //  1. Breakout continuation: price already closed above this strategy's own resistance (a
  //     genuine fresh breakout - prior20High/50High never includes today's own bar) - buy the
  //     confirmed move itself, a tight zone straddling today's close.
  //  2. Anticipatory breakout: hasn't broken out yet but sits close enough to realistically
  //     trigger it - entry is a buy-stop zone AT that resistance up through a small
  //     confirmation buffer, deliberately ABOVE today's close (you commit to paying more only
  //     once the level actually breaks, not before - the standard breakout-order technique).
  //  3. Pullback: trending with a real support anchor still below price - the zone from that
  //     support up to today's close (buy the dip).
  //  4. No usable structure nearby: a narrow zone just under today's close (buying confirmed
  //     strength, not waiting on a pullback that isn't there).
  const anchor = c[cfg.supportKey];
  const maxDistance = cfg.maxAtrMult * atr;
  const alreadyBrokenOut = structHigh != null && lastClose > structHigh;
  const nearResistance = !alreadyBrokenOut && structHigh != null && structHigh > lastClose && structHigh - lastClose <= maxDistance;

  let entryLow, entryHigh;
  if (alreadyBrokenOut) {
    entryLow = lastClose - atr * 0.25;
    entryHigh = lastClose + atr * 0.25;
  } else if (nearResistance) {
    entryLow = structHigh;
    entryHigh = structHigh + cfg.breakoutBufferAtrMult * atr;
  } else {
    const floor = lastClose - maxDistance;
    if (anchor != null && anchor < lastClose && anchor >= floor) {
      entryLow = anchor;
      entryHigh = lastClose;
    } else {
      entryHigh = lastClose;
      entryLow = lastClose - cfg.narrowAtrMult * atr;
    }
  }

  // Stop sits below the WHOLE zone so it protects every possible fill, not just the top of the
  // range; targets are projected conservatively from the top of the zone (the worst-case real
  // entry price within it) so they stay a valid, honest projection no matter where the order
  // actually fills inside that range.
  const stopDistance = cfg.stopAtrMult * atr;
  let stopLoss = entryLow - stopDistance;
  if (structLow != null && structLow < stopLoss && stopLoss - structLow <= stopDistance) {
    stopLoss = structLow * 0.995;
  }
  const risk = entryHigh - stopLoss;
  const target1 = entryHigh + cfg.rr1 * risk;
  const target2 = extendTarget(cfg, target1, risk, false, c.yearHigh);

  return {
    entry_low: Math.round(entryLow),
    entry_high: Math.round(entryHigh),
    max_buy: null,
    target1: Math.round(target1),
    target2: Math.round(target2),
    stop_loss: Math.round(stopLoss),
  };
}

/** Investment: fundamental-led "Max Buy" ceiling instead of a technical entry zone, plus
 * Target1/Target2/stop-loss off that same reference price. */
function computeInvestmentLevels(verdict, c, hasUpcomingCorporateAction) {
  const cfg = RISK_CONFIG.investment;
  const lastClose = c.lastClose;
  const atr = c.atr14 != null && c.atr14 > 0 ? c.atr14 : lastClose * 0.015;
  const structLow = c.yearLow, structHigh = c.yearHigh;
  const stopDistance = cfg.stopAtrMult * atr;

  if (verdict === "Hold") {
    const band = stopDistance * 0.6;
    return {
      entry_low: null, entry_high: null, max_buy: null,
      target1: Math.round(lastClose + band), target2: Math.round(lastClose + band * 1.6),
      stop_loss: Math.round(lastClose - band),
    };
  }

  if (verdict === "Sell" || verdict === "Strong Sell") {
    let stopLoss = lastClose + stopDistance;
    if (structHigh != null && structHigh > stopLoss && structHigh - stopLoss <= stopDistance) stopLoss = structHigh * 1.005;
    const risk = stopLoss - lastClose;
    const target1 = lastClose - cfg.rr1 * risk;
    const target2 = extendTarget(cfg, target1, risk, true, null);
    return { entry_low: null, entry_high: null, max_buy: null, target1: Math.round(target1), target2: Math.round(target2), stop_loss: Math.round(stopLoss) };
  }

  // Buy/Strong Buy: "Max Buy" replaces the technical entry zone entirely for Investment - the
  // highest price genuinely worth paying today, led by the company's own real fundamental
  // valuation rather than where the chart happens to sit.
  //
  // Graham Number: sqrt(22.5 x EPS x BVPS) - a classic, conservative intrinsic-value ceiling
  // (22.5 = Benjamin Graham's own cap of PER<=15 times PBV<=1.5). EPS/BVPS are preferably the
  // REAL figures reported in that company's own quarterly financial statement (net_income/
  // shares, total_equity/shares - scrapers/idx-fundamentals/, see fundamentals_historical
  // above) when that ticker's been scraped; otherwise derived from the real PER/PBV we always have
  // (EPS = price/PER, BVPS = price/PBV) - either way never fabricated, and only computed when
  // the company is actually profitable with positive book equity (a Graham Number is
  // meaningless, or literally imaginary, otherwise).
  const f = c.fundamentals || {};
  const hist = c.fundamentals_historical;
  let fairValue = null;
  // The scraper deliberately keeps a company's own real reporting currency as-is (some IDX
  // miners/energy issuers - ADRO, INCO, ITMG - genuinely report in USD, see
  // scrapers/idx-fundamentals/fetch_fundamentals.py) rather than converting it - so EPS/BVPS
  // here are only trustworthy for this IDR-priced Graham Number when they're actually in IDR;
  // a USD figure combined with an IDR lastClose would silently produce a meaningless result.
  if (hist && hist.currency !== "USD" && hist.eps > 0 && hist.bvps > 0) {
    fairValue = Math.sqrt(22.5 * hist.eps * hist.bvps);
  } else if (f.pe_ttm != null && f.pe_ttm > 0 && f.pb_ratio != null && f.pb_ratio > 0) {
    // f.pe_ttm/pb_ratio come from Zapi/TradingView, a separate provider from the scraper above
    // - unverified whether IT also mixes currencies for USD-reporting issuers the same way
    // Yahoo's own priceToBook was found to (see fetch_fundamentals.py's `sane()`). The
    // plausibility check right below catches that case too, regardless of which source it's
    // from, so this isn't assumed safe just because it isn't the scraper's own known issue.
    const eps = lastClose / f.pe_ttm;
    const bvps = lastClose / f.pb_ratio;
    fairValue = Math.sqrt(22.5 * eps * bvps);
  }
  // A real Graham Number should land in the same rough order of magnitude as the stock's
  // actual traded price - a currency mix-up (or any other data anomaly, from either source
  // above) tends to throw it off by orders of magnitude, not by a normal-looking premium or
  // discount. Discarding anything wildly out of range is a generic safety net that doesn't
  // depend on having caught every possible bad-data case by name.
  if (fairValue != null && (fairValue < lastClose * 0.1 || fairValue > lastClose * 10)) {
    fairValue = null;
  }

  let maxBuy;
  if (fairValue != null) {
    // Margin of safety: a classic 15% value-investing baseline, widened for real fundamental
    // risk (heavy leverage, weak profitability) and narrowed when real technical/volume/broker/
    // corporate-action signals already confirm the thesis - each factor here is a genuine,
    // already-computed real signal, never an invented one.
    let marginPct = 0.15;
    if (f.debt_to_equity != null && f.debt_to_equity > 100) marginPct += 0.05;
    if (f.roe != null && f.roe < 10) marginPct += 0.05;
    if (c.weeklyAdx14 != null && c.weeklyAdx14 >= 25 && c.weeklyPlusDI14 != null && c.weeklyMinusDI14 != null && c.weeklyPlusDI14 > c.weeklyMinusDI14) marginPct -= 0.05;
    if (c.rvol != null && c.rvol >= 1.5) marginPct -= 0.02;
    if (c.broker_buy_concentration != null && c.broker_buy_concentration >= 60) marginPct -= 0.03;
    if (hasUpcomingCorporateAction) marginPct -= 0.02;
    // Real revenue/earnings trend from the same IDX filings, when available - a company
    // actually shrinking needs a bigger discount before it's "safe"; one genuinely growing
    // both lines can accept a slightly tighter one.
    if (hist && hist.revenue_growth_yoy != null && hist.net_income_growth_yoy != null) {
      if (hist.revenue_growth_yoy < 0 && hist.net_income_growth_yoy < 0) marginPct += 0.05;
      else if (hist.revenue_growth_yoy > 5 && hist.net_income_growth_yoy > 5) marginPct -= 0.03;
    }
    marginPct = Math.max(0.05, Math.min(0.35, marginPct));
    maxBuy = fairValue * (1 - marginPct);
  } else {
    // No real PER/PBV for this stock (e.g. negative earnings) - can't compute a real fair
    // value, so fall back to a purely technical ceiling instead of fabricating a fundamental
    // number: never recommend paying above today's real close.
    maxBuy = lastClose;
  }

  let stopLoss = maxBuy - stopDistance;
  if (structLow != null && structLow < stopLoss && stopLoss - structLow <= stopDistance) {
    stopLoss = structLow * 0.995;
  }
  const risk = maxBuy - stopLoss;
  const target1 = maxBuy + cfg.rr1 * risk;
  const target2 = extendTarget(cfg, target1, risk, false, null);

  return {
    entry_low: null,
    entry_high: null,
    max_buy: Math.round(maxBuy),
    target1: Math.round(target1),
    target2: Math.round(target2),
    stop_loss: Math.round(stopLoss),
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

export async function buildDashboard({ fundamentalsHistory } = {}) {
  // Real per-ticker EPS/BVPS/growth from actual quarterly financial statements
  // (scrapers/idx-fundamentals/, run occasionally via .github/workflows/fundamental-scraper.yml
  // - never fetched live here).
  // Optional and looked up by ticker only where Investment's Max Buy calc needs it below;
  // absent entirely (or missing a given ticker) just falls back to the PER/PBV-derived
  // approximation, same as before this existed.
  const fundamentalsHistoryByTicker = fundamentalsHistory?.tickers || {};

  // ---- 1. Bulk data (Zapi Pro tier: cover the whole exchange, not just a slice). Screener
  // and the IHSG chart are both TradingView-sourced and essential - without them there's
  // nothing to build a dashboard from at all, so a failure there (after retries) is left to
  // fail the whole run. IDX's own official scraper backend (index-summary, foreign-flow) is
  // a genuinely separate upstream from TradingView's - confirmed live during a real incident
  // that finance:idx/* can go down as a block while finance:tradingview/* stays healthy - so
  // each degrades on its own below instead of being bundled into one all-or-nothing fetch.
  const [screenerItems, ihsgDaily6m] = await Promise.all([
    withRetry(() => zapi.screener({ count: 500, sortBy: "volume", sortOrder: "desc" })),
    fetchIhsgDailyCandles("IDX:COMPOSITE"),
  ]);

  let ihsgIndex = null;
  try {
    ihsgIndex = await withRetry(() => zapi.idxIndexSummary());
  } catch (e) {
    console.error("idxIndexSummary unavailable after retries, falling back to TradingView chart data for the IHSG level:", e.message);
  }

  let ffTop = [], ffTail = [];
  let foreignFlowAvailable = false;
  try {
    const [ffPage0, ffPage1, ffPage2, ffPage3] = await Promise.all([
      withRetry(() => zapi.idxForeignFlow({ start: 0, length: 200 })),
      withRetry(() => zapi.idxForeignFlow({ start: 200, length: 200 })),
      withRetry(() => zapi.idxForeignFlow({ start: 400, length: 200 })),
      withRetry(() => zapi.idxForeignFlow({ start: 600, length: 200 })),
    ]);
    ffTop = ffPage0;
    ffTail = [...ffPage1, ...ffPage2, ...ffPage3];
    foreignFlowAvailable = true;
  } catch (e) {
    console.error("idxForeignFlow unavailable after retries - will try the Pluang-based foreign-broker proxy instead (falling further back to price-momentum ranking only if that's unusable too):", e.message);
  }

  const composite = ihsgIndex ? ihsgIndex.find((d) => d.IndexCode === "COMPOSITE") : null;
  const lastIhsgCandle = ihsgDaily6m[ihsgDaily6m.length - 1];
  const prevIhsgCandle = ihsgDaily6m[ihsgDaily6m.length - 2] || lastIhsgCandle;
  const ihsg = composite
    ? {
        level: composite.Close,
        change: composite.Change,
        change_pct: Math.round((composite.Change / composite.Previous) * 10000) / 100,
        prev_close: composite.Previous,
        candles: ihsgDaily6m,
        // "All Market" totals (all boards combined) - real, straight from IDX's own
        // index-summary row, no extra call needed. A "Regular board only" breakdown was not
        // found from any working endpoint/param, so it's intentionally left out rather than
        // guessed.
        market_stats: {
          lot: Math.round(composite.Volume / 100),
          value: composite.Value,
          frequency: composite.Frequency,
          number_of_stock: composite.NumberOfStock,
        },
      }
    : {
        // Fallback: derive level/change straight from the (real, TradingView-sourced) daily
        // chart instead of IDX's own index-summary. market_stats has no substitute anywhere
        // (no other provider publishes "All Market" lot/value/frequency totals) - left null
        // and honestly omitted on the dashboard rather than guessed.
        level: lastIhsgCandle.c,
        change: Math.round((lastIhsgCandle.c - prevIhsgCandle.c) * 100) / 100,
        change_pct: Math.round(((lastIhsgCandle.c - prevIhsgCandle.c) / prevIhsgCandle.c) * 10000) / 100,
        prev_close: prevIhsgCandle.c,
        candles: ihsgDaily6m,
        market_stats: null,
      };

  // Real trading-session date this run's data is from, taken from the actual last IHSG daily
  // candle - not whatever day the script happens to execute on. Computed early because the
  // Pluang broker-summary calls below need an explicit date (their default is "today", which
  // is empty on a non-trading day like the deliberate Sunday prep run).
  const lastSessionCandle = ihsg.candles[ihsg.candles.length - 1];
  const sessionDate = lastSessionCandle ? wibDateOf(lastSessionCandle.t) : null;

  // ---- 1b. Real per-stock broker buy/sell detail from Pluang, for the 250 most actively-
  // traded stocks (already sorted by volume from the screener call - covers the large
  // majority of real market transaction value at a sustainable ~6,500 calls/month, confirmed
  // against the real account quota of 25,000/month). Fetched once, reused for THREE things:
  // (a) a net-foreign-flow PROXY (foreign-classified brokers' net buy value, via the real
  // `brokers?type=FOREIGN` classification list) used ONLY as a fallback ranking signal when
  // IDX's own official foreign-flow endpoint is down - genuinely real data, but NOT the same
  // metric as IDX's custodian-tracked foreign ownership flow (some domestic investors trade
  // through "foreign" brokerage houses and vice versa), so it's never presented as that real
  // official figure, only used when the real one truly can't be fetched, and restricted to
  // these 250 stocks rather than the full ~918-stock universe; (b) each active broker's real
  // top buy pick (pure market info, unrelated to our own recommendations); (c) a market-wide
  // "most active broker" ranking fallback if IDX's own broker-summary is ALSO down.
  const MOST_ACTIVE_SCAN_COUNT = 250;
  const brokerScanByTicker = new Map(); // ticker -> { buyers, sellers }
  let foreignBrokerCodes = new Set();
  const brokerNameByCode = new Map(); // broker code -> real firm name, for the Pluang-based fallbacks (their per-stock data has no name field)
  if (sessionDate) {
    try {
      const [foreignList, localList] = await Promise.all([
        withRetry(() => zapi.pluangBrokers({ type: "FOREIGN" })),
        withRetry(() => zapi.pluangBrokers({ type: "LOCAL" })),
      ]);
      for (const b of [...(foreignList.items || []), ...(localList.items || [])]) {
        brokerNameByCode.set(b.code, b.name);
      }
      foreignBrokerCodes = new Set((foreignList.items || []).map((b) => b.code));
    } catch (e) {
      console.error("pluangBrokers unavailable - foreign-flow proxy fallback and Pluang broker names won't be usable if needed:", e.message);
    }
    const scanTickers = screenerItems.slice(0, MOST_ACTIVE_SCAN_COUNT);
    const perStockResults = await Promise.all(
      scanTickers.map((s) =>
        withRetry(() => zapi.pluangBrokerSummary({ code: s.ticker, date: sessionDate }))
          .then((d) => ({ ticker: s.ticker, buyers: d.buyers || [], sellers: d.sellers || [] }))
          .catch((e) => {
            console.error(`pluangBrokerSummary(${s.ticker}) unavailable, skipping this stock:`, e.message);
            return null;
          })
      )
    );
    for (const r of perStockResults) {
      if (r) brokerScanByTicker.set(r.ticker, r);
    }
  }

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

  // ---- 3. Merge screener + foreign flow, rank candidates (deterministic, no AI). Three
  // tiers, best-available-first: (1) real IDX foreign-flow; (2) the Pluang foreign-broker
  // proxy described above, restricted to the 250 scanned stocks; (3) last resort, real price
  // momentum (changePercent) - which isn't a foreign-flow signal at all. net_value stays
  // null in tier 3 so nothing downstream mistakes it for a real (or proxy) foreign-flow
  // number.
  const screenerByTicker = Object.fromEntries(screenerItems.map((s) => [s.ticker, s]));
  const netValueSource = foreignFlowAvailable ? "idx" : foreignBrokerCodes.size > 0 && brokerScanByTicker.size > 0 ? "pluang_proxy" : "none";

  let merged;
  if (netValueSource === "idx") {
    const ffAll = [...ffTop, ...ffTail].map((f) => ({
      ticker: f.code,
      name: f.name,
      net_value: Math.round(f.netForeignShares * f.close),
    }));
    merged = ffAll.filter((f) => screenerByTicker[f.ticker]).map((f) => ({ ...f, ...screenerByTicker[f.ticker] }));
  } else if (netValueSource === "pluang_proxy") {
    merged = screenerItems
      .filter((s) => brokerScanByTicker.has(s.ticker))
      .map((s) => {
        const scan = brokerScanByTicker.get(s.ticker);
        const foreignBuy = scan.buyers.filter((b) => foreignBrokerCodes.has(b.broker)).reduce((a, b) => a + (b.value || 0), 0);
        const foreignSell = scan.sellers.filter((b) => foreignBrokerCodes.has(b.broker)).reduce((a, b) => a + (b.value || 0), 0);
        return { ticker: s.ticker, name: s.name, net_value: Math.round(foreignBuy - foreignSell), ...s };
      });
  } else {
    merged = screenerItems.map((s) => ({ ticker: s.ticker, name: s.name, net_value: null, ...s }));
  }

  const rankByNetValue = netValueSource !== "none";
  const buySide = rankByNetValue
    ? [...merged].sort((a, b) => b.net_value - a.net_value)
    : [...merged].sort((a, b) => b.changePercent - a.changePercent);
  const sellSide = rankByNetValue
    ? [...merged].sort((a, b) => a.net_value - b.net_value)
    : [...merged].sort((a, b) => a.changePercent - b.changePercent);

  // ---- 4. Fetch OHLCV history + compute indicators, one bucket at a time, with automatic
  // backfill: if a candidate's chart data isn't available (delisted symbol, thin/new listing
  // the provider hasn't backfilled, etc.), the next-priority candidate from the same pool
  // takes its place - so the shortlist still ends up with the full 10 Buy / 5 Hold / 5 Sell
  // (20 tickers) instead of silently shrinking. Per the "skip and continue" rule: a bad
  // symbol is replaced, never allowed to abort the whole daily update.
  async function fetchIndicatorsFor(s) {
    try {
      // Daily history (~1.2 years) - used to compute SMA/EMA/RSI/RVOL/pattern plus the
      // 52-week high/low used for Investment's breakout analysis. The binding constraint is
      // Investment's weekly chart: SMA200 needs 200 real prior days warmed up BEFORE its
      // 3-month (~70-day) display window even starts, or the MA200 line only covers part of
      // the chart instead of running its full width - so the floor is 200 + 70 - 1 = 269
      // sessions; 300 leaves comfortable headroom above that (a stock with genuinely less
      // real history than this still just shows a shorter, real, honest line - never padded).
      const candles = await withRetry(() => zapi.chart({ symbol: `IDX:${s.ticker}`, count: 300 }));
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
      // Real broker "bandarmology" concentration for THIS specific stock, via Pluang (the
      // reference methodology's own Top-3-buyer-concentration signal: >=60% concentrated in
      // the top 3 buying brokers, per Section 5, reads as accumulation). Approximated from
      // the top 10 buyers Pluang actually returns (the real data available), not the whole
      // market's true buy-side total - never fatal, a failed/missing call just leaves this
      // null and the signal is skipped rather than guessed.
      let broker_buy_concentration = null;
      if (sessionDate) {
        try {
          const bs = await withRetry(() => zapi.pluangBrokerSummary({ code: s.ticker, date: sessionDate }));
          const buyers = bs.buyers || [];
          const totalValue = buyers.reduce((a, b) => a + (b.value || 0), 0);
          if (totalValue > 0) {
            const top3Value = [...buyers].sort((a, b) => b.value - a.value).slice(0, 3).reduce((a, b) => a + (b.value || 0), 0);
            broker_buy_concentration = Math.round((top3Value / totalValue) * 100);
          }
        } catch (e) {
          console.error(`pluangBrokerSummary(${s.ticker}) unavailable for concentration check, skipping:`, e.message);
        }
      }
      // Real EPS/BVPS/growth from actual quarterly financial statements, when this ticker's been scraped -
      // used by Investment's Max Buy (Graham Number) below in place of the PER/PBV-derived
      // approximation. `null` just means not scraped yet (or genuinely not covered), never a
      // fabricated value.
      // peg is a ticker-level snapshot field (like per/pbv/dividend_yield - see
      // scripts/build-fundamentals-history.mjs), not a per-quarter one, so it isn't already on
      // `.latest` - merged in here so fundamentalScore below can use it without a second lookup.
      const fhEntry = fundamentalsHistoryByTicker[s.ticker];
      const fundamentals_historical = fhEntry?.latest ? { ...fhEntry.latest, peg: fhEntry.peg ?? null } : null;
      return { ...s, ...ind, tv_verdict, cap_tier: capTier(s.marketCap), fundamentals, fundamentals_historical, broker_buy_concentration };
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
    .sort((a, b) => (rankByNetValue ? Math.abs(a.net_value) - Math.abs(b.net_value) : Math.abs(a.changePercent) - Math.abs(b.changePercent)));
  const holdPicks = await fillBucket(holdPool, SHORTLIST_HOLD);

  const sellPool = sellSide.filter((m) => !usedTickers.has(m.ticker));
  const sellPicks = await fillBucket(sellPool, SHORTLIST_SELL);

  const withIndicators = [...buyPicks, ...holdPicks, ...sellPicks];

  // ---- 5. Top 10 most active brokers for the day - MARKET-WIDE, not tied to any specific
  // stock. Real IDX data first choice (verified live that this endpoint has no per-symbol
  // dimension at all - it's inherently market-wide - and is combined buy+sell together, so
  // it ranks brokers by how active they were, never classifies them as net buyers/sellers).
  // If that's down too, falls back to aggregating the Pluang scan above (buyers+sellers
  // across the same 250 stocks) into a broker-level ranking - real data, but scoped to those
  // 250 stocks rather than the whole exchange. Firm names come from the real Pluang
  // LOCAL+FOREIGN broker master list (brokerNameByCode, fetched above) since Pluang's
  // per-stock endpoint itself doesn't carry a name field.
  let activeBrokers = null;
  try {
    const rows = await withRetry(() => zapi.brokerSummary({ length: 100 }));
    const top10 = [...rows]
      .sort((a, b) => b.Value - a.Value)
      .slice(0, 10)
      .map((b) => ({ broker: b.IDFirm, name: b.FirmName, volume: b.Volume, value: b.Value, frequency: b.Frequency }));
    activeBrokers = { date: rows[0] ? rows[0].Date.slice(0, 10) : null, top10, source: "idx" };
  } catch (e) {
    console.error("active broker summary (IDX) fetch failed, trying the Pluang-based fallback:", e.message);
    if (brokerScanByTicker.size > 0) {
      const agg = new Map(); // broker code -> { volume, value }
      for (const { buyers, sellers } of brokerScanByTicker.values()) {
        for (const row of [...buyers, ...sellers]) {
          const cur = agg.get(row.broker) || { volume: 0, value: 0 };
          cur.volume += row.lots || 0;
          cur.value += row.value || 0;
          agg.set(row.broker, cur);
        }
      }
      const top10 = [...agg.entries()]
        .sort((a, b) => b[1].value - a[1].value)
        .slice(0, 10)
        .map(([code, v]) => ({ broker: code, name: brokerNameByCode.get(code) || null, volume: v.volume, value: v.value, frequency: null }));
      if (top10.length) activeBrokers = { date: sessionDate, top10, source: "pluang_proxy" };
    }
  }

  // ---- 5b. Each active broker's real top buy AND top sell pick that day - pure market
  // information, with no connection to our own Buy/Sell recommendations. Reuses the Pluang
  // scan fetched above (no extra calls) - a broker whose real top pick fell outside those
  // 250 stocks simply gets no pick shown, never guessed.
  const topPickMap = new Map(); // broker code -> { ticker, value, avg_price }
  const topSellMap = new Map(); // broker code -> { ticker, value, avg_price }
  for (const [ticker, scan] of brokerScanByTicker.entries()) {
    for (const buyer of scan.buyers) {
      const existing = topPickMap.get(buyer.broker);
      if (!existing || buyer.value > existing.value) {
        topPickMap.set(buyer.broker, { ticker, value: buyer.value, avg_price: buyer.averagePrice ?? null });
      }
    }
    for (const seller of scan.sellers) {
      const existing = topSellMap.get(seller.broker);
      if (!existing || seller.value > existing.value) {
        topSellMap.set(seller.broker, { ticker, value: seller.value, avg_price: seller.averagePrice ?? null });
      }
    }
  }
  if (activeBrokers) {
    activeBrokers.top10 = activeBrokers.top10.map((b) => {
      const pick = topPickMap.get(b.broker);
      const sell = topSellMap.get(b.broker);
      return {
        ...b,
        top_pick_ticker: pick ? pick.ticker : null,
        top_pick_avg_price: pick ? pick.avg_price : null,
        top_sell_ticker: sell ? sell.ticker : null,
        top_sell_avg_price: sell ? sell.avg_price : null,
      };
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
      // Omitted entirely (not sent as null) when there's no usable net-value ranking signal
      // this run, so the narrative never references a "net asing" figure that doesn't
      // actually exist today.
      ...(rankByNetValue ? { net_value: c.net_value } : {}),
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
  // across strategies with just a different label). Methodology follows a reference
  // confluence-scoring framework (Kerangka Analisis Saham: Scalping, Swing, dan Investasi,
  // 13 Sep 2026): count independent real signals pointing the same direction (never a single
  // indicator alone), score bullish and bearish sides separately so genuinely mixed signals
  // land as Hold instead of being forced into a direction, and keep fundamentals completely
  // out of Scalping/Swing's score while making it Investment's single biggest factor. A few
  // of the reference framework's inputs have no real data source available here (KSEI
  // quarterly institutional-ownership trend, macro/sector top-down, qualitative moat/
  // management scoring, DCF intrinsic valuation) - those are intentionally left out rather
  // than faked; everything below is computed from real, already-fetched OHLCV/fundamental/
  // broker data.

  // Scalping confluence (max ~9 bullish / ~7 bearish) - EMA9/21 cross (the reference
  // methodology's own faster scalping pair, vs Swing's slower MA20/50), RVOL>=2x (the
  // reference's own breakout-validity threshold, not just >=1.5x), a fast MACD(8,24,9)
  // golden cross above zero, OBV confirming real buying/selling pressure behind the move,
  // real broker "bandarmology" (top-3 buyer concentration >=60% via Pluang), and a genuine
  // prior-20-day breakout/breakdown.
  function scalpingScore(c) {
    const goldenCross = c.ema9 != null && c.ema21 != null && c.ema9 > c.ema21;
    const deathCross = c.ema9 != null && c.ema21 != null && c.ema9 < c.ema21;
    const highRvol = c.rvol != null && c.rvol >= 2.0;
    const breakout = c.prior20High != null && c.lastClose > c.prior20High;
    const breakdown = c.prior20Low != null && c.lastClose < c.prior20Low;
    const macdBullish = c.macdFastLine != null && c.macdFastSignal != null && c.macdFastLine > c.macdFastSignal && c.macdFastLine > 0;
    const macdBearish = c.macdFastLine != null && c.macdFastSignal != null && c.macdFastLine < c.macdFastSignal && c.macdFastLine < 0;
    const obvBullish = c.obvTrend != null && c.obvTrend > 0;
    const obvBearish = c.obvTrend != null && c.obvTrend < 0;
    const brokerAccumulating = c.broker_buy_concentration != null && c.broker_buy_concentration >= 60;

    let bull = 0, bear = 0;
    if (goldenCross) bull += 2;
    if (deathCross) bear += 2;
    if (highRvol && goldenCross) bull += 2;
    if (highRvol && deathCross) bear += 2;
    if (macdBullish) bull += 1;
    if (macdBearish) bear += 1;
    if (obvBullish) bull += 1;
    if (obvBearish) bear += 1;
    if (brokerAccumulating) bull += 2;
    if (breakout) bull += 1;
    if (breakdown) bear += 1;
    return { bull, bear, maxBull: 9 };
  }
  function scalpingVerdict(c) {
    const { bull, bear } = scalpingScore(c);
    if (bull >= 7) return "Strong Buy";
    if (bull >= 4) return "Buy";
    if (bear >= 6) return "Strong Sell";
    if (bear >= 3) return "Sell";
    return "Hold";
  }

  // Swing confluence (max ~11 bullish) - SMA20/50 trend + a healthy Higher-High/Higher-Low
  // structure, real ADX(14)>25 with +DI>-DI (the reference methodology's own "trend strong
  // enough to ride" test, previously missing entirely from this strategy), a default
  // MACD(12,26,9) golden cross, and a prior-50-day breakout confirmed by RVOL>=2x (the
  // reference's explicit "breakout validity" rule - a breakout on weak volume is a fakeout,
  // so it no longer counts on its own without volume behind it) plus broker accumulation.
  function swingScore(c) {
    const uptrend = c.sma20 != null && c.sma50 != null && c.sma20 > c.sma50 && c.lastClose > c.sma20;
    const downtrend = c.sma20 != null && c.sma50 != null && c.sma20 < c.sma50 && c.lastClose < c.sma20;
    const healthyPattern = (c.pattern || "").includes("uptrend sehat");
    const downPattern = (c.pattern || "").includes("downtrend");
    // RSI(14) 40-60 - the reference methodology's own "area aman beli saat pullback (bukan
    // pucuk)" band (Buku Putih Logika Aplikasi Trading.pdf §3A), tightened from an earlier
    // 45-70 approximation to match that exact real threshold.
    const rsiConstructive = c.rsi14 != null && c.rsi14 >= 40 && c.rsi14 <= 60;
    const rsiWeak = c.rsi14 != null && c.rsi14 < 40;
    const breakoutResistance = c.prior50High != null && c.lastClose > c.prior50High;
    const breakdownSupport = c.prior50Low != null && c.lastClose < c.prior50Low;
    const validRvol = c.rvol != null && c.rvol >= 2.0;
    const adxTrendUp = c.adx14 != null && c.adx14 > 25 && c.plusDI14 != null && c.minusDI14 != null && c.plusDI14 > c.minusDI14;
    const adxTrendDown = c.adx14 != null && c.adx14 > 25 && c.plusDI14 != null && c.minusDI14 != null && c.minusDI14 > c.plusDI14;
    const macdBullish = c.macdLine != null && c.macdSignal != null && c.macdLine > c.macdSignal;
    const macdBearish = c.macdLine != null && c.macdSignal != null && c.macdLine < c.macdSignal;
    const brokerAccumulating = c.broker_buy_concentration != null && c.broker_buy_concentration >= 60;
    // Fibonacci Retracement 0.618/0.5 (Buku Putih §3B "Aksi Harga: ... pemantulan di Fibonacci
    // Retracement (0.618/0.5)") - real levels from the same real 50-day swing high/low already
    // used for breakout/breakdown above, no new data needed. Bullish when price is currently
    // trading inside that classic 50%-61.8% retracement zone measured down from the real
    // swing high - the textbook "buy the pullback" support band, not just any dip.
    const fibHigh = c.prior50High, fibLow = c.prior50Low;
    const fib618 = fibHigh != null && fibLow != null ? fibHigh - (fibHigh - fibLow) * 0.618 : null;
    const fib50 = fibHigh != null && fibLow != null ? fibHigh - (fibHigh - fibLow) * 0.5 : null;
    const fibZone = fib618 != null && fib50 != null && c.lastClose >= fib618 && c.lastClose <= fib50;

    let bull = 0, bear = 0;
    if (uptrend) bull += 2;
    if (downtrend) bear += 2;
    if (adxTrendUp) bull += 2;
    if (adxTrendDown) bear += 2;
    if (healthyPattern) bull += 1;
    if (downPattern) bear += 1;
    if (rsiConstructive) bull += 1;
    if (rsiWeak) bear += 1;
    if (breakoutResistance && validRvol) bull += 2;
    if (breakdownSupport) bear += 1;
    if (macdBullish) bull += 1;
    if (macdBearish) bear += 1;
    if (brokerAccumulating) bull += 2;
    if (fibZone) bull += 1;
    return { bull, bear, maxBull: 12 };
  }
  function swingVerdict(c) {
    const { bull, bear } = swingScore(c);
    if (bull >= 8) return "Strong Buy";
    if (bull >= 4) return "Buy";
    if (bear >= 6) return "Strong Sell";
    if (bear >= 3) return "Sell";
    return "Hold";
  }

  // Investment: long horizon, and genuinely fundamental-driven (not just technical with
  // fundamentals as decoration) - combines TradingView's own multi-indicator technical
  // rating (base direction), the fundamental composite (quality/valuation gate - can pull a
  // technical Buy back to Hold on weak fundamentals, or lift it to Strong Buy on strong
  // ones), a real 52-week breakout/breakdown, WEEKLY ADX(14) trend-intact confirmation (the
  // reference methodology reads trend strength on the weekly chart for this style, not
  // daily), and real daily broker buy concentration as a coarse stand-in for the reference's
  // true signal here (KSEI quarterly institutional-ownership trend) - which isn't available
  // from any data source this pipeline has access to, so it's used only as a minor nudge,
  // never presented as that real quarterly figure.
  function investmentScore(c) {
    let score = 0;
    if (c.tv_verdict) {
      if (c.tv_verdict.includes("strong_buy")) score = 2;
      else if (c.tv_verdict.includes("buy")) score = 1;
      else if (c.tv_verdict.includes("strong_sell")) score = -2;
      else if (c.tv_verdict.includes("sell")) score = -1;
    } else {
      score = c.verdict === "Buy" ? 1 : c.verdict === "Sell" ? -1 : 0;
    }

    const fScore = fundamentalScore(c.fundamentals, c.fundamentals_historical);
    if (fScore >= 15) score += 1;
    else if (fScore <= -15) score -= 1;

    if (c.yearHigh != null && c.lastClose > c.yearHigh) score += 1;
    if (c.yearLow != null && c.lastClose < c.yearLow) score -= 1;

    if (c.weeklyAdx14 != null && c.weeklyAdx14 > 25 && c.weeklyPlusDI14 != null && c.weeklyMinusDI14 != null) {
      if (c.weeklyPlusDI14 > c.weeklyMinusDI14) score += 1;
      else if (c.weeklyMinusDI14 > c.weeklyPlusDI14) score -= 1;
    }

    if (c.broker_buy_concentration != null && c.broker_buy_concentration >= 60) score += 1;

    return score;
  }
  function investmentVerdict(c) {
    const score = investmentScore(c);
    if (score >= 4) return "Strong Buy";
    if (score >= 1) return "Buy";
    if (score <= -4) return "Strong Sell";
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
  function fundamentalScore(f, hist) {
    if (!f) return 0;
    let score = 0;
    if (f.roe != null) score += Math.max(-20, Math.min(40, f.roe));
    if (f.dividend_yield != null) score += f.dividend_yield * 2;
    if (f.debt_to_equity != null) score -= f.debt_to_equity * 10;
    if (f.pe_ttm != null && f.pe_ttm > 0) score -= Math.min(f.pe_ttm, 50) * 0.3;
    // PEG Ratio (PER / real EPS Growth YoY - see scripts/build-fundamentals-history.mjs, only
    // ever computed from real historical growth, never a forecast): classic value-investing
    // read is PEG < 1 = growing faster than its own valuation implies (reward it), PEG > 2 =
    // expensive relative to that real growth (penalize it). Only from the real quarterly
    // scraper data (hist), when this ticker's been covered - null just contributes 0, same as
    // every other optional field here.
    if (hist && hist.peg != null && hist.peg > 0) {
      if (hist.peg < 1) score += (1 - hist.peg) * 15;
      else if (hist.peg > 2) score -= Math.min(hist.peg, 5) * 5;
    }
    return score;
  }

  // "Success Rate" - a transparent, bounded (50-90%) heuristic derived from the EXACT SAME
  // confluence score that produced the Buy/Strong Buy verdict above (never a separate,
  // parallel guess) - the more of the strategy's own real bullish signals fired, the higher
  // the number. It is explicitly NOT a backtested probability - just how strongly this stock
  // clears its strategy's own bullish criteria right now, scaled into a 50-90% range. Shown
  // to the user labeled as an estimate, never as a guaranteed number.
  function potentialPct(strategy, c, verdict) {
    if (!verdict.includes("Buy")) return null;
    let ratio;
    if (strategy === "scalping") {
      const { bull, maxBull } = scalpingScore(c);
      ratio = bull / maxBull;
    } else if (strategy === "swing") {
      const { bull, maxBull } = swingScore(c);
      ratio = bull / maxBull;
    } else {
      // Investment's score isn't bounded the same way (can range roughly -6..6) - clamp the
      // bullish side to a comparable 0..6 scale before converting to a ratio.
      ratio = Math.max(0, investmentScore(c)) / 6;
    }
    return Math.max(50, Math.min(90, Math.round(50 + ratio * 40)));
  }

  function macdLabel(line, signal) {
    if (line == null || signal == null) return "N/A";
    return line > signal ? "Bullish" : "Bearish";
  }

  // Tickers with a real, dated, upcoming corporate action (from section 5d above) - a genuine
  // near-term catalyst, used as one real input to Investment's Max Buy margin of safety.
  const tickersWithCorporateAction = new Set(corporateActions.map((a) => a.ticker));

  // Feature+outcome logging for the ML roadmap (ROADMAP.md §3.5) - one row per card shown,
  // every strategy, every verdict including Hold (never just Buy/Sell like track-record.json,
  // so training data isn't biased toward only the positive calls). Populated inside
  // buildStrategyList below, sent to Supabase by scripts/run-pipeline.mjs, then stripped
  // before latest.json is written - same "internal only, not for the frontend" treatment as
  // price_lookup above.
  const tradeLogRows = [];

  function buildStrategyList(strategy) {
    const verdictFor = strategy === "scalping" ? scalpingVerdict : strategy === "investment" ? investmentVerdict : swingVerdict;
    const scoreFor = strategy === "scalping" ? scalpingScore : strategy === "investment" ? null : swingScore;
    const technicalFor = (c) =>
      strategy === "scalping"
        ? `EMA9 ${c.ema9} | EMA21 ${c.ema21} | RVOL ${c.rvol}x | RSI(7) ${c.rsi7} | ADX ${c.adx14 ?? "N/A"} | MACD ${macdLabel(c.macdFastLine, c.macdFastSignal)} | Broker Top3 ${c.broker_buy_concentration ?? "N/A"}% | ATR(14) ${c.atr14 ?? "N/A"} | Resistance 20D ${c.prior20High} | Support 20D ${c.prior20Low}`
        : strategy === "investment"
        ? `SMA50 ${c.sma50} | SMA200 ${c.sma200} | RSI(14) Mingguan ${c.weeklyRsi14 ?? "N/A"} | ADX Mingguan ${c.weeklyAdx14 ?? "N/A"} | Rating TradingView: ${c.tv_verdict || "N/A"} | ATR(14) ${c.atr14 ?? "N/A"} | Resistance 52W ${c.yearHigh ?? "N/A"} | Support 52W ${c.yearLow ?? "N/A"} | ROE ${c.fundamentals?.roe ?? "N/A"}% | DER ${c.fundamentals?.debt_to_equity ?? "N/A"}`
        : `SMA20 ${c.sma20} | SMA50 ${c.sma50} | RSI(14) ${c.rsi14} | ADX ${c.adx14 ?? "N/A"} | MACD ${macdLabel(c.macdLine, c.macdSignal)} | Broker Top3 ${c.broker_buy_concentration ?? "N/A"}% | ATR(14) ${c.atr14 ?? "N/A"} | Pola: ${c.pattern} | Resistance 50D ${c.prior50High} | Support 50D ${c.prior50Low}`;
    const sourceFor = strategy === "scalping" ? "TradingView (via Zapi) + Pluang (broker), EMA/RVOL/RSI(7)/ADX/MACD/OBV kami hitung sendiri" : strategy === "investment" ? "TradingView rating + fundamental + IDX resmi" : "TradingView (via Zapi) + Pluang (broker), SMA/RSI(14)/ADX/MACD/pola kami hitung sendiri";

    const items = withIndicators.map((c) => {
      const verdict = verdictFor(c);
      const band =
        strategy === "investment"
          ? computeInvestmentLevels(verdict, c, tickersWithCorporateAction.has(c.ticker))
          : computeDirectionalLevels(strategy, verdict, c);
      // Natural-language fallback (only used if Claude's narrative is missing this ticker) -
      // written as a real sentence, not a field-name dump, and always names the volume
      // condition (RVOL) as one of its stated factors, same as the requirement given to Claude.
      const volumeNote =
        c.rvol == null
          ? "data volume belum tersedia"
          : c.rvol >= 1.5
          ? `volume transaksi hari ini ramai, ${c.rvol}x rata-rata 20 hari terakhir`
          : c.rvol < 0.8
          ? `volume transaksi hari ini tipis, hanya ${c.rvol}x rata-rata 20 hari terakhir`
          : `volume transaksi hari ini mendekati normal, ${c.rvol}x rata-rata 20 hari terakhir`;
      const catalyst =
        strategy === "investment"
          ? (narrative.investment_catalysts || {})[c.ticker] || narrative.catalysts[c.ticker] || `Verdict ${verdict} berdasarkan rating teknikal TradingView dan data fundamental yang tersedia untuk saham ini.`
          : narrative.catalysts[c.ticker] ||
            `Verdict ${verdict} didukung oleh ${
              strategy === "scalping"
                ? "pergerakan EMA9 terhadap EMA21 dan momentum RSI(7) jangka pendek"
                : "posisi MA20 terhadap MA50 dan momentum RSI(14)"
            }, dengan ${volumeNote}.`;

      // trade_analysis_log row (see comment above tradeLogRows) - real, already-computed
      // features only, matching Arsitektur Data & ML Roadmap.pdf's schema. score_confluence
      // is bull-minus-bear (Investment has no separate bull/bear score, uses investmentScore
      // directly). entry_price prefers the entry zone's low edge (Scalping/Swing) or Max Buy
      // (Investment) - whichever this strategy actually recommends paying, same as what's
      // shown on the card.
      const scoreBreakdown = scoreFor ? scoreFor(c) : null;
      tradeLogRows.push({
        ticker: c.ticker,
        timeframe_type: strategy === "scalping" ? "Scalping" : strategy === "swing" ? "Swing" : "Investment",
        trend_ihsg: narrative.regime || null,
        feat_rsi_value: strategy === "scalping" ? c.rsi7 : c.rsi14,
        feat_macd_hist: strategy === "scalping"
          ? (c.macdFastLine != null && c.macdFastSignal != null ? round2(c.macdFastLine - c.macdFastSignal) : null)
          : (c.macdLine != null && c.macdSignal != null ? round2(c.macdLine - c.macdSignal) : null),
        feat_price_vs_sma20: c.sma20 ? round2(((c.lastClose - c.sma20) / c.sma20) * 100) : null,
        feat_vol_vs_avg20: c.rvol,
        feat_pbv: c.fundamentals?.pb_ratio ?? null,
        feat_per: c.fundamentals?.pe_ttm ?? null,
        feat_der: c.fundamentals?.debt_to_equity ?? null,
        feat_roe: c.fundamentals?.roe ?? null,
        score_confluence: scoreBreakdown ? scoreBreakdown.bull - scoreBreakdown.bear : investmentScore(c),
        signal_output: verdict,
        entry_price: band.entry_low ?? band.max_buy ?? Math.round(c.lastClose),
        target_tp1: band.target1 ?? null,
        target_sl: band.stop_loss ?? null,
      });

      return {
        ticker: c.ticker,
        name: c.name,
        cap_tier: c.cap_tier,
        verdict,
        potential_pct: potentialPct(strategy, c, verdict),
        // Real, most-recent post-close price (the same real close every indicator above was
        // computed from) - shown alongside entry/target/stop-loss so it's always clear where
        // the market actually is right now vs. the recommended entry zone.
        last_price: Math.round(c.lastClose),
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
        _sortFundamental: strategy === "investment" ? fundamentalScore(c.fundamentals, c.fundamentals_historical) : 0,
        ma_lines:
          strategy === "scalping"
            ? { ema9: c.monthLines.ema9, ema21: c.monthLines.ema21 }
            : strategy === "swing"
            ? { sma20: c.monthLines.sma20, sma50: c.monthLines.sma50 }
            : { sma50: c.chartWeeklyLines.sma50, sma200: c.chartWeeklyLines.sma200 },
      };
    });

    // Buy/Strong Buy calls (the only ones with a real Success Rate) rank by that Success Rate
    // itself, highest first - the whole point of the metric is to say which pick has the most
    // room to run from its recommended entry, so the list should actually read in that order.
    // Hold/Sell calls have no Success Rate (it's only meaningful for a bullish thesis), so
    // they fall back to conviction strength (Strong Sell first), with the fundamental
    // composite as an Investment-only tiebreaker.
    items.sort((a, b) => {
      if (a.potential_pct != null && b.potential_pct != null) return b.potential_pct - a.potential_pct;
      if (a.potential_pct != null) return -1;
      if (b.potential_pct != null) return 1;
      return b._sortStrength - a._sortStrength || b._sortFundamental - a._sortFundamental;
    });
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
    // Real, explicit status per data source - "idx" = primary (official) worked, a named
    // fallback string = primary failed and this real substitute was used instead, "none" =
    // both primary and the fallback failed for this specific piece of data. The frontend
    // uses this to show an honest notice rather than silently presenting fallback/missing
    // data as if it were normal, and the hourly recovery workflow uses it to decide whether
    // a re-run is even worth attempting.
    data_health: {
      ihsg_level_source: composite ? "idx" : "tradingview_chart_fallback",
      net_value_source: netValueSource,
      active_brokers_source: activeBrokers ? activeBrokers.source : "none",
      all_primary_ok: !!composite && netValueSource === "idx",
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
      // "idx" = real official foreign-flow; "pluang_proxy" = real data, but a foreign-
      // brokerage-classification approximation (see netValueSource above), scoped to the 250
      // scanned stocks; "none" = no usable net-value signal at all, ranking fell back to
      // price momentum. The frontend uses this to label the panel honestly (or hide it)
      // instead of ever implying a real official number that isn't actually there.
      net_value_source: netValueSource,
      net_foreign_total: rankByNetValue ? merged.reduce((a, b) => a + b.net_value, 0) : null,
      top_net_buy: rankByNetValue ? buySide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })) : [],
      top_net_sell: rankByNetValue ? sellSide.slice(0, 5).map((x) => ({ ticker: x.ticker, net_value: x.net_value })) : [],
      active_brokers: activeBrokers,
    },
    recommendations: {
      scalping: { updated_at: wibNow.toISOString(), session_note: "Update harian otomatis - RVOL/EMA9-21/RSI7/ADX/MACD/OBV/Broker", items: buildStrategyList("scalping") },
      swing: buildStrategyList("swing"),
      investment: { updated_at: wibNow.toISOString(), items: buildStrategyList("investment") },
    },
    // Which real source drove this (official IDX vs the Pluang-based estimate) is already
    // surfaced once, up top, via data_health/the dashboard's banner - this text stays the
    // same phrasing either way rather than repeating that caveat per stock. Only the
    // genuine "no usable signal at all" case reads differently, since that's a real
    // difference in what actually happened, not just which source it came from.
    watchouts: sellPicks.slice(0, 3).map((s) => ({
      ticker: s.ticker,
      name: s.name,
      reason: rankByNetValue ? "Net sell asing terbesar, verdict teknikal Sell." : "Performa harga terlemah di shortlist, verdict teknikal Sell.",
    })),
    briefing: narrative.briefing,
    // Real current price per ticker (from today's screener, ~300 stocks) - not shown in the
    // UI directly. scripts/run-pipeline.mjs uses this to check yesterday's recommendations
    // against what actually happened, for the real (not estimated) win-rate track record.
    price_lookup: Object.fromEntries(screenerItems.map((s) => [s.ticker, s.last])),
    // Internal only, not for the frontend - see the comment above tradeLogRows/buildStrategyList.
    trade_log_rows: tradeLogRows,
    // The 250 most actively-traded tickers this run's screener saw (already sorted by volume
    // desc - see the screener() call above), written by scripts/run-pipeline.mjs to
    // docs/data/scalping-watchlist.json for scalping-scan.mjs to read during trading hours the
    // next day (ROADMAP.md §3.4) - real, current universe, never a hand-typed list, and reuses
    // data already fetched for MOST_ACTIVE_SCAN_COUNT above rather than costing extra calls.
    scalping_universe: screenerItems.slice(0, MOST_ACTIVE_SCAN_COUNT).map((s) => s.ticker),
  };
}
