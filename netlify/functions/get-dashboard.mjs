// Plain on-demand function - the frontend fetches this to render the page.
import { getStore } from "@netlify/blobs";

export default async function handler() {
  const store = getStore("ihsg-dashboard");
  const data = await store.get("latest", { type: "json" });
  // Debug aid: the last pipeline run's outcome (success or real error message/stack),
  // written by runAndStore() in lib/pipeline.mjs. Background-function failures never
  // otherwise reach anyone - this is how they get surfaced without digging through
  // Netlify's own log UI.
  const lastRunStatus = await store.get("last-run-status", { type: "json" }).catch(() => null);

  if (!data) {
    return new Response(JSON.stringify({ ok: false, message: "Belum ada data - jalankan update pertama dulu.", _debug_last_run: lastRunStatus }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // last 10 history entries
  const { blobs } = await store.list({ prefix: "history-" });
  const history = [];
  for (const b of blobs.slice(-10).reverse()) {
    const h = await store.get(b.key, { type: "json" });
    if (h) history.push(h);
  }

  return new Response(JSON.stringify({ ok: true, ...data, history, _debug_last_run: lastRunStatus }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}
