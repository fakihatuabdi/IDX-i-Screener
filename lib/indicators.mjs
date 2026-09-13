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

  // Resistance/support at three horizons - real prior highs/lows (never today's own bar, so a
  // stock can't "break out" against itself), one per strategy's own timeframe: 20 sessions
  // (~1 month, Scalping), 50 sessions (~2.5 months, Swing), and up to a year (Investment).
  const prior20High = Math.max(...highs.slice(Math.max(0, last - 20), last));
  const prior20Low = Math.min(...lows.slice(Math.max(0, last - 20), last));
  const prior50High = Math.max(...highs.slice(Math.max(0, last - 50), last));
  const prior50Low = Math.min(...lows.slice(Math.max(0, last - 50), last));
  const yearHigh = Math.max(...highs.slice(Math.max(0, last - 252), last));
  const yearLow = Math.min(...lows.slice(Math.max(0, last - 252), last));

  // Chart candles + MA/EMA lines, resampled to each strategy's own timeframe so the visible
  // window and bar spacing actually matches the strategy's horizon (never the same daily
  // chart relabeled three times):
  //  - Scalping & Swing: last ~1 month, grouped into 3-trading-day bars (fewer, chunkier
  //    candles - denser-looking than one bar per day - grouped from the most recent day
  //    backwards so the newest bar is always a full 3-day group).
  //  - Investment: last ~3 months, grouped into real calendar weeks (a genuine weekly bar,
  //    not just "5 days from the end").
  // Every OHLCV value inside a group is real; grouping only aggregates it (high = max of the
  // group's highs, etc.) - nothing here is estimated. Each line's value at a bar is the
  // real daily MA/EMA value as of that bar's last trading day, so it still lines up with the
  // bar's close.
  const oneMonthWindow = Math.min(22, n);
  const monthCandles = candles.slice(n - oneMonthWindow);
  const { candles: candles3d, lines: chart3dLines } = resampleFromEnd(monthCandles, 3, {
    ema13: ema13.slice(n - oneMonthWindow), ema21: ema21.slice(n - oneMonthWindow),
    sma20: sma20.slice(n - oneMonthWindow), sma50: sma50.slice(n - oneMonthWindow),
  });

  const threeMonthWindow = Math.min(70, n);
  const quarterCandles = candles.slice(n - threeMonthWindow);
  const { candles: candlesWeekly, lines: chartWeeklyLines } = resampleByWeek(quarterCandles, {
    sma50: sma50.slice(n - threeMonthWindow), sma200: sma200.slice(n - threeMonthWindow),
  });

  return {
    lastClose,
    ema13: round1(ema13[last]), ema21: round1(ema21[last]),
    rsi5: round1(rsi5[last]), rsi14: round1(rsi14[last]),
    sma20: round1(sma20[last]), sma50: round1(sma50[last]), sma200: round1(sma200[last]),
    rvol: round2(rvol),
    pattern, verdict,
    prior20High: round1(prior20High), prior20Low: round1(prior20Low),
    prior50High: round1(prior50High), prior50Low: round1(prior50Low),
    yearHigh: round1(yearHigh), yearLow: round1(yearLow),
    candles3d, chart3dLines,
    candlesWeekly, chartWeeklyLines,
  };
}

/** Groups `dailyCandles` (and, in step, each series in `dailySeries`) from the END backwards
 * into chunks of `groupSize` trading days - the newest group is always full-sized; only the
 * oldest group at the far edge of the window may be shorter. */
function resampleFromEnd(dailyCandles, groupSize, dailySeries) {
  const bounds = [];
  for (let end = dailyCandles.length; end > 0; end -= groupSize) bounds.unshift([Math.max(0, end - groupSize), end]);
  return buildResampled(dailyCandles, dailySeries, bounds);
}

/** Groups `dailyCandles` (and each series in `dailySeries`) by real calendar week (Mon-based). */
function resampleByWeek(dailyCandles, dailySeries) {
  const bounds = [];
  let curKey = null, start = 0;
  for (let i = 0; i < dailyCandles.length; i++) {
    const key = weekKeyOf(dailyCandles[i].date);
    if (key !== curKey) { if (i > start) bounds.push([start, i]); start = i; curKey = key; }
  }
  bounds.push([start, dailyCandles.length]);
  return buildResampled(dailyCandles, dailySeries, bounds);
}

function weekKeyOf(dateStr) {
  // Zapi's candle `date` is already a full ISO timestamp (e.g. "2026-09-11T02:00:00.000Z"),
  // not a plain "YYYY-MM-DD" - appending a second time-of-day here used to produce an
  // unparseable string, so `d` became Invalid Date and `toISOString()` below threw for
  // every single candle, which silently killed every stock's indicator computation (caught
  // per-ticker, logged, and replaced - so it looked like "no candidates" instead of an error).
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function buildResampled(dailyCandles, dailySeries, bounds) {
  const candles = bounds.map(([s, e]) => {
    const chunk = dailyCandles.slice(s, e);
    return {
      o: chunk[0].open,
      h: Math.max(...chunk.map((c) => c.high)),
      l: Math.min(...chunk.map((c) => c.low)),
      c: chunk[chunk.length - 1].close,
      v: chunk.reduce((a, c) => a + (c.volume || 0), 0),
      t: chunk[chunk.length - 1].date,
    };
  });
  const lines = {};
  for (const [key, arr] of Object.entries(dailySeries)) {
    lines[key] = bounds.map(([, e]) => round1(arr[e - 1]));
  }
  return { candles, lines };
}

function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }
