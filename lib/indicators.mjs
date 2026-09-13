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
 * MACD: fast EMA minus slow EMA, plus a signal line (EMA of that difference). The reference
 * trading methodology tunes these periods per style - faster (e.g. 8,24,9) for Scalping's
 * quick noise, the classic default (12,26,9) for Swing's daily chart.
 */
export function macd(closes, fastPeriod, slowPeriod, signalPeriod) {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const n = closes.length;
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fast[i] != null && slow[i] != null) macdLine[i] = fast[i] - slow[i];
  }
  const validStart = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(n).fill(null);
  if (validStart >= 0) {
    const sig = ema(macdLine.slice(validStart), signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] != null) signalLine[validStart + i] = sig[i];
    }
  }
  const histogram = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (macdLine[i] != null && signalLine[i] != null) histogram[i] = macdLine[i] - signalLine[i];
  }
  return { macdLine, signalLine, histogram };
}

/**
 * On-Balance Volume: cumulative volume added on up days, subtracted on down days - confirms
 * whether a price move is backed by real buying/selling pressure rather than thin volume.
 */
export function obv(closes, volumes) {
  const n = closes.length;
  const out = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const vol = volumes[i] || 0;
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + vol;
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - vol;
    else out[i] = out[i - 1];
  }
  return out;
}

/**
 * Wilder's ADX/+DI/-DI: trend strength (ADX) and direction (whichever of +DI/-DI is on top).
 * ADX > 25 with +DI > -DI is the reference methodology's own "trend strong enough to ride"
 * confirmation, used here for Swing (daily) and Investment (weekly).
 */
export function adx(highs, lows, closes, period) {
  const n = closes.length;
  const tr = new Array(n).fill(null);
  const plusDM = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff = lows[i - 1] - lows[i];
    plusDM[i] = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    minusDM[i] = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  const adxOut = new Array(n).fill(null);
  if (n > period) {
    let smTR = 0, smPlusDM = 0, smMinusDM = 0;
    for (let i = 1; i <= period; i++) { smTR += tr[i] || 0; smPlusDM += plusDM[i] || 0; smMinusDM += minusDM[i] || 0; }
    plusDI[period] = smTR ? (100 * smPlusDM) / smTR : 0;
    minusDI[period] = smTR ? (100 * smMinusDM) / smTR : 0;
    dx[period] = plusDI[period] + minusDI[period] ? (100 * Math.abs(plusDI[period] - minusDI[period])) / (plusDI[period] + minusDI[period]) : 0;
    for (let i = period + 1; i < n; i++) {
      smTR = smTR - smTR / period + (tr[i] || 0);
      smPlusDM = smPlusDM - smPlusDM / period + (plusDM[i] || 0);
      smMinusDM = smMinusDM - smMinusDM / period + (minusDM[i] || 0);
      plusDI[i] = smTR ? (100 * smPlusDM) / smTR : 0;
      minusDI[i] = smTR ? (100 * smMinusDM) / smTR : 0;
      dx[i] = plusDI[i] + minusDI[i] ? (100 * Math.abs(plusDI[i] - minusDI[i])) / (plusDI[i] + minusDI[i]) : 0;
    }
    const adxStart = period * 2 - 1; // first ADX needs `period` DX values (DX itself starts at index `period`)
    if (n > adxStart) {
      let sumDx = 0;
      for (let i = period; i <= adxStart; i++) sumDx += dx[i] || 0;
      adxOut[adxStart] = sumDx / period;
      for (let i = adxStart + 1; i < n; i++) {
        adxOut[i] = (adxOut[i - 1] * (period - 1) + (dx[i] || 0)) / period;
      }
    }
  }
  return { adx: adxOut, plusDI, minusDI };
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

  // Periods matched to the reference trading methodology: Scalping trades a fast EMA9/EMA21
  // cross and RSI(7); Swing/Investment share RSI(14) but read it on their own timeframe
  // (daily vs weekly, see weeklyRsi14 below).
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi7 = rsi(closes, 7);
  const rsi14 = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, Math.min(50, n - 1));
  const sma200 = sma(closes, Math.min(200, n - 1));
  const obvSeries = obv(closes, volumes);
  const { adx: adxDaily, plusDI: plusDIDaily, minusDI: minusDIDaily } = adx(highs, lows, closes, 14);
  // Scalping's own faster MACD tuning (8,24,9) alongside the classic daily default (12,26,9)
  // used for Swing - two different noise tolerances for two different holding periods.
  const macdFast = macd(closes, 8, 24, 9);
  const macdDefault = macd(closes, 12, 26, 9);

  const last = n - 1;
  const lastClose = closes[last];

  // RVOL: today's volume vs avg of prior 20 sessions
  let avgVol20 = 0, cnt = 0;
  for (let k = 2; k <= 21 && last - k >= 0; k++) { avgVol20 += volumes[last - k]; cnt++; }
  avgVol20 = cnt > 0 ? avgVol20 / cnt : volumes[last] || 1;
  const rvol = avgVol20 > 0 ? volumes[last] / avgVol20 : 1;

  // OBV trend: now vs 5 sessions ago - rising means the move is backed by real net
  // buying/selling pressure, not just price drifting on thin volume.
  const obvTrend = last >= 5 ? obvSeries[last] - obvSeries[last - 5] : null;

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

  // Chart candles + MA/EMA lines, matched to each strategy's own timeframe so the visible
  // window actually reflects the strategy's horizon (never the same daily chart relabeled
  // three times):
  //  - Scalping & Swing: last ~1 month, one real bar per trading day (~22 bars) - every
  //    session stays visible so the pattern is genuinely readable, not merged away.
  //  - Investment: last ~3 months, grouped into real calendar weeks (a genuine weekly bar,
  //    not just "5 days from the end") - aggregated because 3 months of daily bars would be
  //    too cramped to read, and week-level detail is what a long-horizon thesis needs anyway.
  // Every OHLCV value is real; grouping (for the weekly view) only aggregates it (high = max
  // of the group's highs, etc.) - nothing here is estimated. Each line's value at a bar is
  // the real daily MA/EMA value as of that bar's last trading day.
  const oneMonthWindow = Math.min(22, n);
  const candlesMonth = candles.slice(n - oneMonthWindow).map(toChartCandle);
  const monthLines = {
    ema9: ema9.slice(n - oneMonthWindow).map(round1),
    ema21: ema21.slice(n - oneMonthWindow).map(round1),
    sma20: sma20.slice(n - oneMonthWindow).map(round1),
    sma50: sma50.slice(n - oneMonthWindow).map(round1),
  };

  const threeMonthWindow = Math.min(70, n);
  const quarterCandles = candles.slice(n - threeMonthWindow);
  const { candles: candlesWeekly, lines: chartWeeklyLines } = resampleByWeek(quarterCandles, {
    sma50: sma50.slice(n - threeMonthWindow), sma200: sma200.slice(n - threeMonthWindow),
  });

  // Weekly RSI/ADX for Investment's own timeframe (the reference methodology reads RSI and
  // ADX on WEEKLY bars for this style, not daily - a slower, less noisy read of the big
  // trend). Resampled from as much real history as was fetched (not just the 3-month display
  // window above), so there are enough weekly bars to actually warm up a 14-period read.
  const { candles: weeklyForIndicators } = resampleByWeek(candles, {});
  const weeklyCloses = weeklyForIndicators.map((c) => c.c);
  const weeklyHighs = weeklyForIndicators.map((c) => c.h);
  const weeklyLows = weeklyForIndicators.map((c) => c.l);
  const weeklyRsi14Series = rsi(weeklyCloses, 14);
  const { adx: weeklyAdxSeries, plusDI: weeklyPlusDISeries, minusDI: weeklyMinusDISeries } = adx(weeklyHighs, weeklyLows, weeklyCloses, 14);
  const wLast = weeklyCloses.length - 1;

  return {
    lastClose,
    ema9: round1(ema9[last]), ema21: round1(ema21[last]),
    rsi7: round1(rsi7[last]), rsi14: round1(rsi14[last]),
    sma20: round1(sma20[last]), sma50: round1(sma50[last]), sma200: round1(sma200[last]),
    rvol: round2(rvol),
    obvTrend: obvTrend == null ? null : Math.round(obvTrend),
    adx14: round1(adxDaily[last]), plusDI14: round1(plusDIDaily[last]), minusDI14: round1(minusDIDaily[last]),
    macdFastLine: round2(macdFast.macdLine[last]), macdFastSignal: round2(macdFast.signalLine[last]),
    macdLine: round2(macdDefault.macdLine[last]), macdSignal: round2(macdDefault.signalLine[last]),
    weeklyRsi14: round1(weeklyRsi14Series[wLast]),
    weeklyAdx14: round1(weeklyAdxSeries[wLast]), weeklyPlusDI14: round1(weeklyPlusDISeries[wLast]), weeklyMinusDI14: round1(weeklyMinusDISeries[wLast]),
    pattern, verdict,
    prior20High: round1(prior20High), prior20Low: round1(prior20Low),
    prior50High: round1(prior50High), prior50Low: round1(prior50Low),
    yearHigh: round1(yearHigh), yearLow: round1(yearLow),
    candlesMonth, monthLines,
    candlesWeekly, chartWeeklyLines,
  };
}

function toChartCandle(c) { return { o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, t: c.date }; }

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
