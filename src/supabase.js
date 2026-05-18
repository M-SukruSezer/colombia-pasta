// ─── Supabase REST API istemcisi ───────────────────────────────────────────────
// Gerçek web uygulamasında Supabase'e direkt bağlanabiliyoruz.

const SUPABASE_URL = "https://hqlzpixwvfsyczqshnwf.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhxbHpwaXh3dmZzeWN6cXNobndmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNDU3MjUsImV4cCI6MjA5NDYyMTcyNX0.QKUn6IH_hOQ48zIbVTe9oGdm22GRojL73mMweHpPkfk";

export async function supabase(path, method = "GET", body = null, prefer = "return=representation") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
}
