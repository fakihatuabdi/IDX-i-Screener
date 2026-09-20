// Thin client for the Zapi platform (api.zpi.web.id) - TradingView + IDX scrapers.
// Reads the key from process.env.ZAPI_KEY (set as a GitHub Actions secret, never hardcode it).

const BASE = "https://api.zpi.web.id";

async function callZapi(path, params) {
  const key = process.env.ZAPI_KEY;
  if (!key) throw new Error("ZAPI_KEY environment variable is not set");
  const qs = new URLSearchParams(params || {});
  const url = `${BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  const res = await fetch(url, { headers: { "x-api-key": key, Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Zapi ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.data;
}

/** Bulk universe scan: price, change%, marketCap, sector, PE for many stocks in one call. */
export function screener({ count = 150, sortBy = "volume", sortOrder = "desc" } = {}) {
  return callZapi("/v1/finance:tradingview/screener", { market: "indonesia", count, sortBy, sortOrder }).then((d) => d.items);
}

/** Official IDX index level (COMPOSITE/LQ45/etc). */
export function idxIndexSummary() {
  return callZapi("/v1/finance:idx/index-summary", {}).then((d) => d.data);
}

/** Official daily net foreign buy/sell per stock, in SHARES (multiply by close for rupiah). */
export function idxForeignFlow({ start = 0, length = 200 } = {}) {
  return callZapi("/v1/finance:idx/foreign-flow", { sort: "net", start, length }).then((d) => d.data);
}

/** Daily OHLCV candles for a symbol, e.g. "IDX:BBCA" or "IDX:COMPOSITE". */
export function chart({ symbol, count = 210, resolution = "1D" }) {
  return callZapi("/v1/finance:tradingview/chart", { symbol, market: "indonesia", resolution, count }).then(
    (d) => d.candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date }))
  );
}

/**
 * TradingView's own technical-rating summary for a symbol (Strong Buy/Buy/Neutral/Sell/Strong Sell).
 * Used to determine verdict/ranking. Callers should wrap this in try/catch: a single failed
 * ticker must not abort the whole run, per the "skip and continue" error-handling rule.
 */
export function technicals({ symbol }) {
  return callZapi("/v1/finance:tradingview/technicals", { symbol, market: "indonesia" }).then((d) => ({
    summary: (d.summary || d.recommendation || "").toString().toLowerCase().replace(/\s+/g, "_"),
  }));
}

/**
 * Real fundamentals (dividend yield, payout ratio, debt/equity, ROE, balance sheet
 * figures) for one stock, straight from TradingView. Market cap and PE TTM are NOT
 * here - we already have those from screener(), no need for another call.
 */
export function financials({ symbol }) {
  return callZapi("/v1/finance:tradingview/financials", { symbol, market: "indonesia" }).then((d) => d);
}

/** Recent IDX exchange news/announcements. Optional `q` keyword filter. */
export function idxNews({ length = 15, q } = {}) {
  const params = { length };
  if (q) params.q = q;
  return callZapi("/v1/finance:idx/news", params).then((d) => d.data);
}

/** Real corporate actions (dividend, rights, split, listing/delisting) for one stock, straight from IDX. */
export function corporateActions({ code }) {
  return callZapi("/v1/finance:idx/corporate-actions", { code }).then((d) => d.items);
}

/**
 * Top active brokers for the day, MARKET-WIDE (real IDX data via Zapi) - confirmed via a live
 * direct test that this endpoint has no per-stock dimension at all: passing different real
 * tickers, an invalid ticker, or no ticker param whatsoever all return byte-identical rows,
 * and the row shape itself (IDFirm/FirmName/Volume/Value/Frequency) carries no ticker field.
 * So this ranks each broker's total transaction volume/value/frequency across the WHOLE
 * exchange that session - never "this broker's activity in stock X" (that was never actually
 * true, even before this was noticed - a `symbol`/`code` param was always silently ignored).
 * Also combined (buy+sell together) - IDX/Zapi doesn't expose a buy vs sell split here, so
 * this ranks brokers by how active they were, not classifies them as net buyers/sellers.
 */
export function brokerSummary({ length = 200 } = {}) {
  return callZapi("/v1/finance:idx/broker-summary", { length }).then((d) => d.data);
}

/**
 * Real top-10 buyer/seller brokers for ONE stock over a date range, from Pluang (via Zapi) -
 * unlike the IDX-sourced broker-summary above, this genuinely varies by stock (verified live
 * with two different tickers returning different broker rankings and prices). Each entry in
 * `buyers`/`sellers` is `{broker, lots, value, averagePrice}` - real transaction value and
 * average execution price for that specific stock and broker, summed by the upstream API over
 * the whole real range (not something this client sums itself). `date` (used as `endDate`)
 * must be an actual trading day (YYYY-MM-DD) - it isn't defaulted to "today" here because
 * "today" is empty on a non-trading day. `startDate` defaults to `date` itself (a single real
 * day) when omitted - pass it explicitly for a real multi-day window (e.g. Swing's Bandarmologi
 * "last 5 days" check, see lib/pipeline.mjs). `net` (upstream default true) nets each broker's
 * own buy against their own sell; pass `net: false` for real gross buy/sell lots when what's
 * needed is a total-market net-buy-vs-net-sell comparison, not a per-broker net.
 * NOTE: unlike brokerSummary() above, this response has no extra nested "data" layer -
 * callZapi() already unwraps the one real "data" level, so don't re-unwrap with `.data` again
 * here (that silently produced `undefined`, which is what broke every single call before).
 */
export function pluangBrokerSummary({ code, date, startDate, net } = {}) {
  const params = { code, startDate: startDate || date, endDate: date };
  if (net != null) params.net = net;
  return callZapi("/v1/finance:pluang/broker-summary", params);
}

/**
 * Real, static-ish reference list of IDX broker codes Pluang classifies as LOCAL or FOREIGN.
 * Used only as a fallback: combined with pluangBrokerSummary()'s real per-stock buyer/seller
 * data, it lets us build a "foreign-classified brokers' net buy value" proxy when IDX's own
 * official foreign-flow endpoint (real custodian-tracked ownership flow) is unavailable.
 * This is explicitly an approximation, not the same metric - some domestic investors trade
 * through "foreign" brokerage houses and vice versa - so it's never presented as the real
 * official figure, only used when that real figure genuinely can't be fetched.
 */
export function pluangBrokers({ type } = {}) {
  return callZapi("/v1/finance:pluang/brokers", type ? { type } : {});
}

/**
 * CNN-style Fear & Greed sentiment (0-100) for US equities - confirmed via a live test that
 * this is inherently US-market data (its 7 sub-indicators are US-specific instruments: junk
 * bond spreads, US equity put/call ratio, etc.) - there is no separate Indonesia or other-
 * country breakdown available from this provider, only "stocks" (US) and "crypto" (global).
 */
export function fearGreedStocks({ count = 1 } = {}) {
  return callZapi("/v1/finance:fear-greed/stocks", { count });
}

/** Fear & Greed sentiment (0-100) for crypto - global, not region-specific. */
export function fearGreedCrypto({ count = 1 } = {}) {
  return callZapi("/v1/finance:fear-greed/crypto", { count });
}

// ---- Pluang intraday endpoints (added for the Scalping module - see ROADMAP.md §3.4).
// Real data confirmed against Zapi's own Pluang API reference: 5-minute intraday candles,
// best-bid/best-ask order book (not full depth-of-book), and tick-level running trades tagged
// with the real aggressor side (BUY = hit the offer/HAKA, SELL = hit the bid) - nothing here is
// estimated or interpolated between real prints.

/**
 * Intraday candles for the CURRENT session only, real 5-minute bars (the finest resolution
 * Pluang's upstream actually serves - never resampled down to a fake 1-minute bar). Used to
 * compute session VWAP (cumulative typical-price*volume / cumulative volume) and a fast
 * EMA/RSI read on real intraday price action.
 */
export function pluangChart({ code, stockId } = {}) {
  const params = {};
  if (code) params.code = code;
  if (stockId) params.stockId = stockId;
  return callZapi("/v1/finance:pluang/chart", params);
}

/** Real best bid/ask + lots and bid%/ask% split - the reference methodology's "Order Book Dynamics" signal. Level-1 only (no full depth-of-book). */
export function pluangOrderBook({ code, stockId } = {}) {
  const params = {};
  if (code) params.code = code;
  if (stockId) params.stockId = stockId;
  return callZapi("/v1/finance:pluang/orderbook", params);
}

/**
 * Real tick-by-tick trade prints, newest first, each tagged with the real aggressor side -
 * this IS the reference methodology's "Tape Reading (Hajar Kanan/HAKA)" signal: sum real BUY
 * lots vs real SELL lots in a recent window to get Offer_Eaten_Rate vs Bid_Eaten_Rate.
 */
export function pluangRunningTrades({ code, stockId, action, minLot, cursor } = {}) {
  const params = {};
  if (code) params.code = code;
  if (stockId) params.stockId = stockId;
  if (action) params.action = action;
  if (minLot != null) params.minLot = minLot;
  if (cursor) params.cursor = cursor;
  return callZapi("/v1/finance:pluang/running-trades", params);
}

/** Batched bid/ask/OHLC snapshot for up to 20 stocks in ONE call - the quota-efficient way to check many tickers' last price/quote at once instead of one call per ticker. */
export function pluangMultiQuote({ codes, stockIds } = {}) {
  const params = {};
  if (codes) params.codes = Array.isArray(codes) ? codes.join(",") : codes;
  if (stockIds) params.stockIds = Array.isArray(stockIds) ? stockIds.join(",") : stockIds;
  return callZapi("/v1/finance:pluang/summary", params);
}
