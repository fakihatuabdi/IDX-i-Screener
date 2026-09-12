// Netlify Scheduled Function - runs automatically on the cron below (UTC!).
// Runs after market close, not before open: 19:00 WIB = 12:00 UTC, weekdays only -> "0 12 * * 1-5"
// NOTE: Netlify does not allow invoking a schedule()-wrapped function directly
// over HTTP (calling it manually returns 502 before our code even runs) - for
// manual testing use run-update.mjs instead, which shares the same pipeline.
import { schedule } from "@netlify/functions";
import { runAndStore } from "./lib/pipeline.mjs";

async function handler() {
  try {
    const dashboard = await runAndStore();
    return new Response(JSON.stringify({ ok: true, trading_date: dashboard.meta.trading_date }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("daily-update failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

// Runs automatically at 12:00 UTC = 19:00 WIB, Monday-Friday only (1-5 = Mon-Fri in
// cron's day-of-week field) - IDX doesn't trade on weekends, so there's no new session
// to report on Saturday/Sunday.
export default schedule("0 12 * * 1-5", handler);
