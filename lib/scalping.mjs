// Intraday Scalping computation - real data only (Pluang via Zapi, see ROADMAP.md §3.4).
// Pure functions, no network calls here - scripts/scalping-scan.mjs does the fetching.
import { ema, rsi, atr } from "./indicators.mjs";

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

/**
 * ATR-based volatility context (Spesifikasi Algorithmic Trading & ML.pdf §1.1: "ATR >
 * rata-rata 5 hari") - real daily ATR(14) (Wilder, same function used everywhere else in this
 * project) from real daily candles, averaged over the last 5 real trading days as the
 * baseline. Compared against today's own real realized range so far (highest high minus
 * lowest low across today's real intraday bars) - an honest approximation, not a literal
 * apples-to-apples ATR (a same-day intraday range isn't the same statistic as a completed
 * day's Wilder ATR), so the 0.7x threshold is deliberately conservative: today's range
 * already covering most of a typical full day's range, while the session is still ongoing,
 * is a real sign of elevated volatility. This is informational context (the reference
 * document lists it as a confirmation/liquidity-conditions parameter, not a directional
 * bull/bear trigger - it says nothing about which way price is moving) rather than a 7th
 * bull/bear vote in scalpingSignals below.
 */
export function atrDailyBaseline(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 20) return null;
  const highs = dailyCandles.map((c) => c.high);
  const lows = dailyCandles.map((c) => c.low);
  const closes = dailyCandles.map((c) => c.close);
  const series = atr(highs, lows, closes, 14).filter((v) => v != null);
  if (!series.length) return null;
  const last5 = series.slice(-5);
  return Math.round((last5.reduce((a, b) => a + b, 0) / last5.length) * 100) / 100;
}

export function isAtrElevated(todayIntradayBars, atr5dAvg) {
  if (!todayIntradayBars?.length || !(atr5dAvg > 0)) return null;
  const todayRange = Math.max(...todayIntradayBars.map((b) => b.high)) - Math.min(...todayIntradayBars.map((b) => b.low));
  return todayRange > atr5dAvg * 0.7;
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
  // volumeBreakout is the literal, direction-agnostic condition from Buku Putih §2A
  // ("Current_Vol > MA_Vol_20 x 1.5") - used as-is by primaryVerdict's strict Entry AND-rule
  // below. volBull/volBear stay a stricter, direction-confirmed variant (breakout AND the bar
  // itself closed the way that direction implies) for the secondary 6-signal matrix only -
  // deliberately not the same thing, so neither one is silently doing double duty.
  if (lastBar != null && avgBarVolume != null && avgBarVolume > 0) {
    const breakout = lastBar.volume > avgBarVolume * 1.5;
    flags.volumeBreakout = breakout;
    flags.volBull = breakout && lastBar.close > lastBar.open;
    flags.volBear = breakout && lastBar.close < lastBar.open;
  }
  if (bidPercent != null) {
    flags.bookBull = bidPercent >= 55;
    flags.bookBear = bidPercent <= 45;
  }
  // Offer_Eaten_Rate > Bid_Eaten_Rate (Buku Putih §2A) is a literal simple majority - fixed
  // from an earlier, too-strict 60/40 split back to the document's actual >50% threshold.
  if (buyLots != null && sellLots != null && buyLots + sellLots > 0) {
    flags.tapeBull = buyLots > sellLots;
    flags.tapeBear = sellLots > buyLots;
  }

  const bull = Object.entries(flags).filter(([k, v]) => k.endsWith("Bull") && v).length;
  const bear = Object.entries(flags).filter(([k, v]) => k.endsWith("Bear") && v).length;
  return { bull, bear, flags };
}

/**
 * The Scalping ENTRY rule exactly as written in Buku Putih §2B - a strict AND of 3 specific
 * real conditions, used as the PRIMARY verdict (the generic bull/bear-count matrix above,
 * verdictFromCounts, is now computed only as secondary/informational context for this
 * module - same "parallel, not authoritative" treatment already used for Swing/Investment's
 * Varian B). "Price crosses above VWAP" needs the PREVIOUS cycle's real price-vs-VWAP
 * position (this scan runs every 5 minutes - a genuine cross is only real across two actual
 * consecutive observations) - `wasAboveVwap` missing (first time this ticker's been scanned)
 * honestly means "no cross confirmed yet", never guessed. The Sell-side mirror (cross below +
 * volume breakout + tape majority sell) isn't in the reference document, which only defines
 * a Buy entry here - added by symmetry, consistent with how this project extends other
 * Buy-only rules the same way elsewhere.
 */
export function primaryVerdict({ lastPrice, vwap, wasAboveVwap, volumeBreakout, buyLots, sellLots, bull, bear }) {
  const isAboveVwap = vwap != null && lastPrice != null ? lastPrice >= vwap : null;
  const crossUp = isAboveVwap === true && wasAboveVwap === false;
  const crossDown = isAboveVwap === false && wasAboveVwap === true;
  const tapeBuyMajority = buyLots != null && sellLots != null && buyLots > sellLots;
  const tapeSellMajority = buyLots != null && sellLots != null && sellLots > buyLots;

  const buyTriggered = crossUp && volumeBreakout === true && tapeBuyMajority;
  const sellTriggered = crossDown && volumeBreakout === true && tapeSellMajority;
  // The document's own Entry rule doesn't define a graduated Strong/plain tier - once it has
  // actually fired, the secondary 6-signal count (Buku Putih §1's system-wide matrix) is
  // reused purely to size conviction, never to fire the entry on its own.
  if (buyTriggered) return { verdict: bull >= 5 ? "Strong Buy" : "Buy", isAboveVwap };
  if (sellTriggered) return { verdict: bear >= 5 ? "Strong Sell" : "Sell", isAboveVwap };
  return { verdict: "Hold", isAboveVwap };
}

/**
 * A real, deterministic Indonesian-language summary of exactly which flags fired - built
 * straight from the same six real signals scalpingSignals just computed, never a separate
 * guess. No Claude API call here on purpose: this scan runs every 5 minutes for up to 30
 * tickers, and calling an LLM that often would add real cost/latency for no benefit over a
 * template built directly from already-real, already-labeled data.
 */
export function buildCatalyst({ ticker, verdict, flags, rsi7, bidPercent, atrElevated }) {
  const parts = [];
  if (flags.vwapBull) parts.push("harga di atas VWAP sesi");
  else if (flags.vwapBear) parts.push("harga di bawah VWAP sesi");
  if (flags.emaBull) parts.push("EMA3 di atas EMA5 dan EMA9 (momentum naik cepat)");
  else if (flags.emaBear) parts.push("EMA3 di bawah EMA5 dan EMA9 (momentum turun cepat)");
  if (flags.rsiBull) parts.push(`RSI(7) di area oversold (${rsi7})`);
  else if (flags.rsiBear) parts.push(`RSI(7) di area overbought (${rsi7})`);
  if (flags.volBull) parts.push("breakout volume ke atas");
  else if (flags.volBear) parts.push("breakout volume ke bawah");
  if (flags.bookBull) parts.push(`order book didominasi bid (${bidPercent}%)`);
  else if (flags.bookBear) parts.push(`order book didominasi ask (${bidPercent != null ? 100 - bidPercent : null}%)`);
  if (flags.tapeBull) parts.push("tape reading menunjukkan tekanan beli (Hajar Kanan)");
  else if (flags.tapeBear) parts.push("tape reading menunjukkan tekanan jual (Hajar Kiri)");

  let sentence = parts.length
    ? `Verdict ${verdict} untuk ${ticker} didukung oleh ${parts.join(", ")}.`
    : `Belum ada sinyal teknikal intraday yang cukup kuat untuk ${ticker} saat ini.`;
  if (atrElevated) sentence += " Volatilitas intraday sedang lebih tinggi dari rata-rata 5 hari terakhir.";
  return sentence;
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
 * Entry/Max Buy/TP1/TP2/SL for Scalping. Entry/TP1/TP2/SL follow the exact fixed percentages
 * specified in Buku Putih Logika Aplikasi Trading.pdf §2B - "Eksekusi pada harga Offer (Hajar
 * Kanan)", i.e. this is deliberately a momentum/breakout-style entry AT the real current
 * price the moment the confluence signal validates, not a discount/pullback zone like
 * Swing/Investment - so entry always equals the real scanned price by design, not a bug.
 * max_buy is a real, small execution-slippage ceiling on top of that: by the time an order
 * actually reaches the exchange a few minutes after this scan (the next real cycle is 5
 * minutes away), price may already have moved further in the signal's favor - paying above
 * this ceiling means chasing past where the confluence signal was actually validated, eroding
 * the reward:risk this setup was computed for. Only meaningful for a Buy call; Sell calls act
 * at the real market price with no equivalent "how much higher is still safe" question.
 */
export function scalpingLevels(verdict, lastPrice) {
  const isBuy = verdict.includes("Buy");
  const isSell = verdict.includes("Sell");
  if (!isBuy && !isSell) return { entry: null, max_buy: null, target1: null, target2: null, stop_loss: null };
  const sign = isBuy ? 1 : -1;
  return {
    entry: Math.round(lastPrice),
    max_buy: isBuy ? Math.round(lastPrice * 1.005) : null,
    target1: Math.round(lastPrice * (1 + sign * 0.015)),
    target2: Math.round(lastPrice * (1 + sign * 0.03)),
    stop_loss: Math.round(lastPrice * (1 - sign * 0.015)),
  };
}
