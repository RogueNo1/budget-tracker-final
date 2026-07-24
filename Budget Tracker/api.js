// ───────────────────────────────────────────────
// Talks to /.netlify/functions/transactions.
// The function verifies the Netlify Identity token
// server-side and reads/writes Supabase with the
// service role key, so no Supabase key ever ships
// to the browser.
// ───────────────────────────────────────────────
window.Api = (function () {
  const ENDPOINT = '/.netlify/functions/transactions';

  async function authHeaders() {
    const token = await Auth.currentToken();
    if (!token) throw new Error('Not logged in');
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  }

  async function fetchTransactions() {
    const headers = await authHeaders();
    const res = await fetch(ENDPOINT, { headers });
    if (!res.ok) throw new Error('Could not load transactions (' + res.status + ')');
    const data = await res.json();
    return data.transactions || [];
  }

  // Sends a batch of normalised transactions to be upserted.
  // Duplicates (same user + account + dedupe_key) are skipped
  // server-side by a unique constraint, so importing the same
  // file twice is always safe.
  async function importTransactions(txns) {
    const headers = await authHeaders();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transactions: txns })
    });
    if (!res.ok) throw new Error('Could not save transactions (' + res.status + ')');
    return res.json(); // { inserted, skipped }
  }

  return { fetchTransactions, importTransactions };
})();
