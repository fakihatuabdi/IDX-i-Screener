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
 * Per-broker trading activity for one stock's last session, straight from IDX (via Zapi).
 * NOTE: this is combined activity (buy+sell together) per broker - IDX/Zapi does not expose
 * a buy-side vs sell-side split at this granularity, so this can only rank brokers by how
 * active they were, not classify them as net buyers/sellers.
 */
export function brokerSummary({ symbol, length = 200 }) {
  return callZapi("/v1/finance:idx/broker-summary", { symbol, length }).then((d) => d.data);
}
