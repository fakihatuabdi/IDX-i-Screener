// Manual-trigger entry point, as a Netlify BACKGROUND function.
// The "-background" filename suffix is what tells Netlify to run this without the
// ~40s gateway response timeout that a plain on-demand function is bound by - the
// caller gets an immediate empty 202 response, and this keeps running for real
// (up to 15 minutes) until the pipeline finishes and writes to Blobs. Check
// /api/dashboard a bit later (30-90s) to see the result.
// NOTE: Background functions use the classic named "handler" export, not the
// newer `export default` Request/Response style used by get-dashboard.mjs.
import { runAndStore } from "./lib/pipeline.mjs";

export async function handler() {
  try {
    const dashboard = await runAndStore();
    console.log("run-update-background completed OK for", dashboard.meta.trading_date);
  } catch (err) {
    console.error("run-update-background failed:", err);
  }
}
