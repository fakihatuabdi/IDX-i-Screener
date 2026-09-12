// Plain on-demand function for MANUAL testing/triggering via /api/run-update.
// Runs the exact same pipeline as the 08:00 WIB scheduled update (daily-update.mjs),
// just without the schedule() wrapper - Netlify blocks direct HTTP calls to a
// schedule()-wrapped function, so this twin entry point exists purely so a human
// (or this Claude Code session) can trigger a real run on demand.
import { runAndStore } from "./lib/pipeline.mjs";

export default async function handler() {
  try {
    const dashboard = await runAndStore();
    return new Response(JSON.stringify({ ok: true, trading_date: dashboard.meta.trading_date }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("run-update failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
