// Plain on-demand function - the frontend fetches this to render the page.
import { getStore } from "@netlify/blobs";

export default async function handler() {
  const store = getStore("ihsg-dashboard");
  const data = await store.get("latest", { type: "json" });

  if (!data) {
    return new Response(JSON.stringify({ ok: false, message: "Belum ada data - jalankan update pertama dulu." }), {
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

  return new Response(JSON.stringify({ ok: true, ...data, history }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
}
