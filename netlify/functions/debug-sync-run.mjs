// TEMPORARY diagnostic function - plain synchronous (not background), so any error
// inside the pipeline comes straight back in the HTTP response instead of vanishing
// into a Background Function that appears to never actually execute on this account.
// Delete this file once the run-update-background mystery is resolved.
import { runAndStore } from "./lib/pipeline.mjs";

export default async function handler() {
  try {
    const dashboard = await runAndStore();
    return new Response(JSON.stringify({ ok: true, trading_date: dashboard.meta.trading_date }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, stack: err.stack }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
