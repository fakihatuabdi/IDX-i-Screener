// Calls the real Claude API (console.anthropic.com), NOT Claude Code.
// Key from process.env.ANTHROPIC_API_KEY.

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
SEMUA ANGKA DI BAWAH INI SUDAH DIHITUNG DARI DATA REAL - jangan mengarang angka baru, jangan mengubah verdict/entry/target/stop_loss yang sudah diberikan. Tugasmu HANYA menulis teks (catalyst per saham, ringkasan regime pasar, briefing harian) berdasarkan angka yang ada.

DATA IHSG:
${JSON.stringify(ihsg)}

DATA SEKTOR (rata-rata perubahan harga per sektor, dari data real):
${JSON.stringify(sectors)}

DAFTAR SAHAM KANDIDAT (verdict, entry/target/stop_loss, dan indikator SUDAH FINAL - jangan diubah):
${JSON.stringify(candidates)}

Kembalikan HANYA JSON valid dengan struktur persis ini (tanpa markdown, tanpa penjelasan lain):
{
  "regime": "label singkat regime pasar, mis. 'Selektif, Bukan Rally Merata'",
  "market_summary": "1-2 kalimat ringkas kondisi pasar hari ini",
  "technical_overview": "1 paragraf overview teknikal pasar + observasi lintas saham kandidat",
  "briefing": "1 paragraf briefing harian singkat merangkum semuanya",
  "catalysts": { "TICKER": "1-2 kalimat catalyst spesifik untuk saham ini berdasarkan verdict dan indikatornya", ... satu entri per ticker di daftar kandidat }
}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}
