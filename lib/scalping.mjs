// Intraday Scalping computation - real data only (Pluang via Zapi, see ROADMAP.md §3.4).
// Pure functions, no network calls here - scripts/scalping-scan.mjs does the fetching.
import { ema, rsi } from "./indicators.mjs";

/**
 * Session VWAP from real 5-minute bars (Pluang's own candle granularity - the finest
 * available, see lib/zapi.mjs pluangChart): cumulative (typical price x volume) over
 * cumulative volume, the standard VWAP definition applied to real OHLCV bars rather than raw
 * ticks (Pluang doesn't expose tick-level trade prices outside running-trades, which has no
 * volume-weighted price field of its own).
 */
export function sessionVwap(chartItems) {
  let pv = 0, vol = 0;
  for (const bar of chartItems) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume;
    vol += bar.volume;
  }
  return vol > 0 ? pv / vol : null;
}

/** EMA3/EMA5/EMA9 + RSI7 from the real 5-minute close series - the fastest periods the reference methodology defines, applied to the finest real resolution Pluang actually serves. */
export function microIndicators(chartItems) {
  const closes = chartItems.map((b) => b.close);
  return {
    ema3: last(ema(closes, 3)),
    ema5: last(ema(closes, 5)),
    ema9: last(ema(closes, 9)),
    rsi7: last(rsi(closes, 7)),
  };
}

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return Math.round(arr[i] * 100) / 100;
  return null;
}

/**
 * Six real, independent bullish/bearish signals - VWAP position, Micro EMA alignment, RSI(7)
 * oversold/overbought, a directional volume breakout on the latest bar, Order Book Dynamics
 * (real bid/ask lot split), and Tape Reading/HAKA (real aggressor-tagged running trades). Each
 * one only fires when its real underlying data is actually available - a missing input just
 * contributes to neither side, never guessed.
 */
export function scalpingSignals({ lastPrice, vwap, ema3, ema5, ema9, rsi7, lastBar, avgBarVolume, bidPercent, buyLots, sellLots }) {
  const flags = {};
  if (lastPrice != null && vwap != null) {
    flags.vwapBull = lastPrice >= vwap;
    flags.vwapBear = lastPrice < vwap;
  }
  if (ema3 != null && ema5 != null && ema9 != null) {
    flags.emaBull = ema3 > ema5 && ema5 > ema9;
    flags.emaBear = ema3 < ema5 && ema5 < ema9;
  }
  if (rsi7 != null) {
    flags.rsiBull = rsi7 <= 25; // near oversold - rebound setup, matches the reference's "RSI_7 crosses above 20" zone
    flags.rsiBear = rsi7 >= 75; // near overbought
  }
  if (lastBar != null && avgBarVolume != null && avgBarVolume > 0) {
    const breakout = lastBar.volume > avgBarVolume * 1.5;
    flags.volBull = breakout && lastBar.close > lastBar.open;
    flags.volBear = breakout && lastBar.close < lastBar.open;
  }
  if (bidPercent != null) {
    flags.bookBull = bidPercent >= 55;
    flags.bookBear = bidPercent <= 45;
  }
  if (buyLots != null && sellLots != null && buyLots + sellLots > 0) {
    const buyRatio = buyLots / (buyLots + sellLots);
    flags.tapeBull = buyRatio >= 0.6;
    flags.tapeBear = buyRatio <= 0.4;
  }

  const bull = Object.entries(flags).filter(([k, v]) => k.endsWith("Bull") && v).length;
  const bear = Object.entries(flags).filter(([k, v]) => k.endsWith("Bear") && v).length;
  return { bull, bear, flags };
}

/**
 * Generic bullish/bearish-count verdict matrix, straight from Buku Putih Logika Aplikasi
 * Trading.pdf §1 (unweighted - every signal counts equally, unlike the main daily pipeline's
 * weighted scoring in lib/pipeline.mjs, which is a deliberately different design - see
 * ROADMAP.md §1.4/§3.3). Used here as-is since this is a brand-new module with no existing
 * live behavior to disrupt, effectively trialling this exact matrix in parallel per the
 * roadmap's own recommendation.
 */
export function verdictFromCounts(bull, bear) {
  if (bull >= 4 && bear === 0) return "Strong Buy";
  if (bull >= 3 && bear <= 1) return "Buy";
  if (bear >= 4 && bull === 0) return "Strong Sell";
  if (bear >= 3 && bull <= 1) return "Sell";
  return "Hold";
}

/**
 * Entry/TP1/TP2/SL exactly as specified for Scalping in Buku Putih Logika Aplikasi
 * Trading.pdf §2B - simple fixed percentages from the real entry price, deliberately
 * different from the daily pipeline's ATR-based bands (documented there as a real, different
 * formula for this specific fast/intraday style, not an oversight).
 */
export function scalpingLevels(verdict, lastPrice) {
  const isBuy = verdict.includes("Buy");
  const isSell = verdict.includes("Sell");
  if (!isBuy && !isSell) return { entry: null, target1: null, target2: null, stop_loss: null };
  const sign = isBuy ? 1 : -1;
  return {
    entry: Math.round(lastPrice),
    target1: Math.round(lastPrice * (1 + sign * 0.015)),
    target2: Math.round(lastPrice * (1 + sign * 0.03)),
    stop_loss: Math.round(lastPrice * (1 - sign * 0.015)),
  };
}
