// Shared technical-indicator math, computed from raw OHLCV candles.
// Pure functions, no network calls here.

export function ema(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (i === period - 1) {
      const slice = closes.slice(0, period);
      prev = slice.reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = (closes[i] - prev) * k + prev;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period, avgLoss = losses / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Compute the full indicator set the dashboard needs from a plain
 * ascending-by-date array of {open,high,low,close,volume} candles.
 */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume || 0);
  const n = closes.length;

  const ema13 = ema(closes, 13);
  const ema21 = ema(closes, 21);
  const rsi5 = rsi(closes, 5);
  const rsi14 = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, Math.min(50, n - 1));
  const sma200 = sma(closes, Math.min(200, n - 1));

  const last = n - 1;
  const lastClose = closes[last];

  // RVOL: today's volume vs avg of prior 20 sessions
  let avgVol20 = 0, cnt = 0;
  for (let k = 2; k <= 21 && last - k >= 0; k++) { avgVol20 += volumes[last - k]; cnt++; }
  avgVol20 = cnt > 0 ? avgVol20 / cnt : volumes[last] || 1;
  const rvol = avgVol20 > 0 ? volumes[last] / avgVol20 : 1;

  // Pattern: compare last-10-day window split in half for HH/HL
  const win = 10;
  const start = Math.max(0, n - win);
  const recentHighs = highs.slice(start);
  const recentLows = lows.slice(start);
  const half = Math.floor(recentHighs.length / 2);
  const firstHalfHigh = Math.max(...recentHighs.slice(0, half || 1));
  const secondHalfHigh = Math.max(...recentHighs.slice(half));
  const firstHalfLow = Math.min(...recentLows.slice(0, half || 1));
  const secondHalfLow = Math.min(...recentLows.slice(half));
  const higherHigh = secondHalfHigh > firstHalfHigh;
  const higherLow = secondHalfLow > firstHalfLow;
  let pattern;
  if (higherHigh && higherLow) pattern = "Higher High + Higher Low (uptrend sehat)";
  else if (!higherHigh && !higherLow) pattern = "Lower High + Lower Low (downtrend)";
  else if (higherHigh && !higherLow) pattern = "Higher High, Lower Low (volatil melebar)";
  else pattern = "Lower High, Higher Low (konsolidasi menyempit)";

  // Rule-based verdict from SMA50/SMA200 trend (no AI needed - deterministic, real numbers)
  let verdict = "Hold";
  if (sma50[last] != null && sma200[last] != null) {
    if (lastClose > sma50[last] && sma50[last] > sma200[last]) verdict = "Buy";
    else if (lastClose > sma50[last] && lastClose > sma200[last]) verdict = "Buy";
    else if (lastClose < sma50[last] && sma50[last] < sma200[last]) verdict = "Sell";
    else if (lastClose < sma50[last] && lastClose < sma200[last]) verdict = "Sell";
  }

  const prior20High = Math.max(...highs.slice(Math.max(0, last - 20), last));
  const prior20Low = Math.min(...lows.slice(Math.max(0, last - 20), last));

  return {
    lastClose,
    ema13: round1(ema13[last]), ema21: round1(ema21[last]),
    rsi5: round1(rsi5[last]), rsi14: round1(rsi14[last]),
    sma20: round1(sma20[last]), sma50: round1(sma50[last]), sma200: round1(sma200[last]),
    rvol: round2(rvol),
    pattern, verdict,
    prior20High: round1(prior20High), prior20Low: round1(prior20Low),
    candles20: candles.slice(-20).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
  };
}

function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }
