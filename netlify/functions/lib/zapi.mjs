// Thin client for the Zapi platform (api.zpi.web.id) - TradingView + IDX scrapers.
// Reads the key from process.env.ZAPI_KEY (set in Netlify's env var UI, never hardcode it).

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
    (d) => d.candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  );
}

/**
 * TradingView's own technical-rating summary for a symbol (Strong Buy/Buy/Neutral/Sell/Strong Sell).
 * Used only for the Investment strategy, which requires this to be Buy/Strong Buy - never derived
 * from our own SMA rule alone. Callers should wrap this in try/catch: a single failed ticker must
 * not abort the whole run, per the "skip and continue" error-handling rule.
 */
export function technicals({ symbol }) {
  return callZapi("/v1/finance:tradingview/technicals", { symbol, market: "indonesia" }).then((d) => ({
    summary: (d.summary || d.recommendation || "").toString().toLowerCase().replace(/\s+/g, "_"),
  }));
}
