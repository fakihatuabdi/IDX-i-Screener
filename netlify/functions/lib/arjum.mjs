// Thin client for stock.arjum.com ("IDX Edge PRO"). Key from process.env.ARJUM_KEY.

const BASE = "https://stock.arjum.com";

async function callArjum(path, params) {
  const key = process.env.ARJUM_KEY;
  if (!key) throw new Error("ARJUM_KEY environment variable is not set");
  const qs = new URLSearchParams(params || {});
  const url = `${BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  const res = await fetch(url, { headers: { "X-API-Key": key, Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`arjum ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Per-broker buy/sell breakdown for one ticker (for the Bandarmology highlight). */
export async function brokerSummary(code) {
  const j = await callArjum("/api/broker-summary/" + code);
  return j.brokers || [];
}
