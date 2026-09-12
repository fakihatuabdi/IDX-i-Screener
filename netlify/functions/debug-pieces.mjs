// TEMPORARY diagnostic - exercises only the NEWEST pieces (financials, news,
// corporate actions, broker summary, Claude narrative) against a tiny sample, fast
// enough to stay under the gateway timeout. Delete once the real bug is found.
import * as zapi from "./lib/zapi.mjs";
import { writeNarrative } from "./lib/claude.mjs";

async function safe(name, fn) {
  try {
    const result = await fn();
    return { name, ok: true, result };
  } catch (e) {
    return { name, ok: false, error: e.message, stack: e.stack };
  }
}

export default async function handler() {
  const results = await Promise.all([
    safe("financials", () => zapi.financials({ symbol: "IDX:BBCA" })),
    safe("idxNews", () => zapi.idxNews({ length: 5 })),
    safe("corporateActions", () => zapi.corporateActions({ code: "BBRI" })),
    safe("brokerSummary", () => zapi.brokerSummary({ symbol: "BBRI", length: 200 })),
    safe("writeNarrative", () =>
      writeNarrative({
        ihsg: { level: 6541, change_pct: -0.5 },
        sectors: [{ name: "Finance", change_pct: -0.3 }],
        candidates: [{ ticker: "BBCA", verdict: "Buy", changePercent: 1.2, net_value: 1000000, rsi14: 55, pattern: "test", fundamentals: { market_cap: 1e15, pe_ttm: 20, dividend_yield: 2.5, payout_ratio: 60, debt_to_equity: 0.2, roe: 18, pb_ratio: 3 } }],
      })
    ),
  ]);
  return new Response(JSON.stringify({ results }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
