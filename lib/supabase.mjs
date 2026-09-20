// Thin client for the Supabase project's PostgREST API - used to persist
// trade_analysis_log/trade_labels for the ML roadmap (see ROADMAP.md §3.5, §4).
// Reads credentials from process.env.SUPABASE_URL / SUPABASE_SERVICE_KEY (GitHub Actions
// secrets, never hardcoded) - the service_role key, which bypasses Row Level Security
// entirely (RLS is enabled on both tables specifically to block the public anon key, which
// this project never uses or exposes anywhere - there is no browser-side Supabase client).

function creds() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY environment variables are not set");
  return { url: url.replace(/\/$/, ""), key };
}

async function request(path, { method = "GET", query, body, prefer } = {}) {
  const { url, key } = creds();
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** SELECT rows from `table`. `filters` are raw PostgREST query params, e.g. {select: "a,b", timestamp: "gte.2026-01-01"}. */
export function select(table, filters = {}) {
  return request(table, { query: filters });
}

/** INSERT `rows` (array of plain objects) into `table`. Returns the inserted rows (with server-generated fields like log_id). No-ops on an empty array - never sends an empty POST body. */
export function insertRows(table, rows) {
  if (!rows.length) return Promise.resolve([]);
  return request(table, { method: "POST", body: rows, prefer: "return=representation" });
}

/** UPSERT `rows` into `table`, keyed on `conflictColumn` (its primary/unique key) - overwrites an existing row with the same key instead of erroring on duplicate. */
export function upsertRows(table, rows, conflictColumn) {
  if (!rows.length) return Promise.resolve([]);
  return request(table, { method: "POST", query: { on_conflict: conflictColumn }, body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
}
