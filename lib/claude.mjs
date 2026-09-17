// Calls the real Claude API (console.anthropic.com), NOT Claude Code.
// Key from process.env.ANTHROPIC_API_KEY (set as a GitHub Actions secret).

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"; // cheap+fast; upgrade to claude-sonnet-5 for richer prose

/**
 * Ask Claude to write the narrative/text layer of the dashboard from
 * already-computed, real numbers. Claude never invents prices, verdicts,
 * or rankings here - those are computed deterministically upstream and
 * simply handed in; Claude's only job is turning them into good copy and
 * returning it as strict JSON.
 */
export async function writeNarrative({ ihsg, sectors, candidates }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Kamu menulis narasi untuk dashboard watchlist saham IHSG (Bahasa Indonesia).
SEMUA ANGKA DI BAWAH INI SUDAH DIHITUNG DARI DATA REAL - jangan mengarang angka baru, jangan mengubah verdict/indikator/fundamental yang sudah diberikan (entry/target/stop-loss dihitung terpisah di luar sini, tidak perlu dan tidak boleh disebutkan angkanya di catalyst). Tugasmu HANYA menulis teks (catalyst per saham, ringkasan regime pasar, briefing harian) berdasarkan angka yang ada.

ATURAN BAHASA UNTUK CATALYST (PENTING): tulis dengan bahasa manusia yang natural dan mengalir, seperti analis menjelaskan ke investor awam - JANGAN PERNAH menyalin nama field/variabel mentah ke dalam kalimat (jangan tulis "lastClose", "prior20High", "prior50Low", "yearHigh", "rvol", "sma50", dst secara harfiah). Terjemahkan ke istilah yang dipahami orang biasa, misalnya: lastClose -> "harga saat ini/harga penutupan", prior20High/prior50High -> "resistance 20/50 hari terakhir", prior20Low/prior50Low -> "support 20/50 hari terakhir", yearHigh/yearLow -> "level tertinggi/terendah 52 minggu", rvol -> "volume transaksi Nx rata-rata".

DATA IHSG:
${JSON.stringify(ihsg)}

DATA SEKTOR (rata-rata perubahan harga per sektor, dari data real):
${JSON.stringify(sectors)}

DAFTAR SAHAM KANDIDAT (verdict, indikator teknikal, dan fundamental SUDAH FINAL - jangan diubah; field fundamental yang null berarti datanya memang tidak tersedia, jangan ditulis seolah ada angkanya):
${JSON.stringify(candidates)}

Kembalikan HANYA JSON valid dengan struktur persis ini (tanpa markdown, tanpa penjelasan lain):
{
  "regime": "label singkat regime pasar, mis. 'Selektif, Bukan Rally Merata'",
  "market_summary": "1-2 kalimat ringkas kondisi pasar hari ini",
  "technical_overview": "1 paragraf overview teknikal pasar + observasi lintas saham kandidat",
  "briefing": "1 paragraf briefing harian singkat merangkum semuanya",
  "catalysts": { "TICKER": "1-2 kalimat catalyst spesifik untuk saham ini berdasarkan verdict dan indikator TEKNIKAL-nya saja (jangan sebut angka fundamental di sini - ini dipakai untuk strategi Scalping/Swing yang murni teknikal), WAJIB ikuti ATURAN BAHASA di atas (bahasa natural, jangan sebut nama field mentah). Kalau harga sudah menembus resistance 20/50 hari (breakout) atau jatuh di bawah support 20/50 hari (breakdown) yang diberikan, WAJIB sebutkan level breakout/breakdown riil itu dengan bahasa natural - ini bukti validitas analisis, jangan dilewatkan kalau datanya ada. WAJIB juga sebutkan kondisi VOLUME transaksi (rvol) sebagai salah satu faktor analisis dengan bahasa natural - apakah volume mendukung pergerakan harga (di atas rata-rata = sinyal lebih meyakinkan) atau justru tipis (di bawah rata-rata = sinyal masih perlu dikonfirmasi)", ... satu entri per ticker di daftar kandidat },
  "investment_catalysts": { "TICKER": "2-3 kalimat khusus untuk strategi Investment, WAJIB ikuti ATURAN BAHASA di atas: WAJIB sebutkan angka fundamental riil yang tersedia untuk saham ini (PER, PBV, Dividend Yield, Payout Ratio, DER, ROE - hanya yang ada datanya, skip yang null) sebagai DASAR UTAMA analisis, bukan pelengkap, lalu simpulkan apakah valuasi & kualitas fundamentalnya mendukung atau melemahkan tesis investasi jangka panjang. Kombinasikan dengan verdict teknikalnya (rating TradingView), sebutkan juga kondisi volume transaksi terkini sebagai konfirmasi tambahan (bahasa natural, bukan 'rvol'), DAN kalau datanya ada, sebutkan juga posisi harga terhadap resistance/support 52 minggu - misalnya breakout ke level tertinggi 52 minggu sebagai konfirmasi momentum jangka panjang, atau posisi dekat level terendah 52 minggu sebagai sinyal waspada", ... satu entri per ticker di daftar kandidat }
}`;

  // ~20 tickers x 2 catalyst fields (catalysts + investment_catalysts), each now longer
  // since they must cite real breakout/resistance levels - 4500 was cutting the JSON off
  // mid-string on a full shortlist. Headroom raised well above the realistic max.
  return callClaudeForJson(client, prompt, 8000);
}

/**
 * Friday's run replaces new recommendations with a recap of how THIS week's real,
 * already-evaluated calls actually performed (win rate, best/worst pick) - all numbers
 * given here are final; Claude only turns them into a short narrative paragraph.
 */
export async function writeWeeklySummary({ weekLabel, stats, bestPick, worstPick }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Kamu menulis rekap performa mingguan untuk dashboard watchlist saham IHSG (Bahasa Indonesia). Hari ini Jumat - bukan hari untuk rekomendasi baru, tapi untuk merangkum hasil rekomendasi minggu ini.
SEMUA ANGKA SUDAH DIHITUNG DARI DATA REAL (harga sungguhan yang sudah terjadi) - jangan mengarang angka baru.

MINGGU: ${weekLabel}
STATISTIK WIN RATE MINGGU INI (sudah final): ${JSON.stringify(stats)}
SAHAM PERFORMA TERBAIK MINGGU INI: ${JSON.stringify(bestPick)}
SAHAM PERFORMA TERBURUK MINGGU INI: ${JSON.stringify(worstPick)}

Kembalikan HANYA JSON valid dengan struktur persis ini (tanpa markdown, tanpa penjelasan lain):
{
  "headline": "1 kalimat pendek merangkum performa minggu ini (jujur - kalau win rate rendah, akui saja, jangan dipoles)",
  "recap": "1-2 paragraf rekap performa minggu ini: sebutkan win rate keseluruhan dan per strategi, highlight saham performa terbaik & terburuk beserta alasannya berdasarkan data yang ada, dan pelajaran untuk minggu depan"
}`;

  return callClaudeForJson(client, prompt, 1200);
}

async function callClaudeForJson(client, prompt, maxTokens) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  const candidate = text.slice(jsonStart, jsonEnd + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // stop_reason "max_tokens" means the response was cut off mid-JSON - the real fix is a
    // higher max_tokens on the call above, not a parsing workaround here. Log enough of the
    // raw text to see exactly where/why it broke instead of just a byte offset.
    console.error(`callClaudeForJson: JSON.parse failed (stop_reason=${msg.stop_reason}). Tail of response:`, candidate.slice(-500));
    throw e;
  }
}
