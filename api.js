// ───────────────────────────────────────────────
// Talks to /.netlify/functions/transactions and
// /.netlify/functions/categories. Both verify the
// Netlify Identity token server-side and use Supabase's
// service role key there, so no Supabase key ever ships
// to the browser.
// ───────────────────────────────────────────────
window.Api = (function () {
  const TXN_ENDPOINT = '/.netlify/functions/transactions';
  const CAT_ENDPOINT = '/.netlify/functions/categories';

  async function authHeaders() {
    const token = await Auth.currentToken();
    if (!token) throw new Error('Not logged in');
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  }

  async function fetchTransactions() {
    const headers = await authHeaders();
    const res = await fetch(TXN_ENDPOINT, { headers });
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
    const res = await fetch(TXN_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transactions: txns })
    });
    if (!res.ok) throw new Error('Could not save transactions (' + res.status + ')');
    return res.json(); // { inserted, skipped }
  }

  // Edits one or more transactions (single edit or bulk recategorize).
  async function updateTransactions(ids, patch) {
    const headers = await authHeaders();
    const res = await fetch(TXN_ENDPOINT, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ids, patch })
    });
    if (!res.ok) throw new Error('Could not update transaction(s) (' + res.status + ')');
    return res.json();
  }

  async function deleteTransactions(ids) {
    const headers = await authHeaders();
    const res = await fetch(TXN_ENDPOINT, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ ids })
    });
    if (!res.ok) throw new Error('Could not delete transaction(s) (' + res.status + ')');
    return res.json();
  }

  async function fetchCategories() {
    const headers = await authHeaders();
    const res = await fetch(CAT_ENDPOINT, { headers });
    if (!res.ok) throw new Error('Could not load categories (' + res.status + ')');
    const data = await res.json();
    return data.categories || [];
  }

  async function addCategory(name) {
    const headers = await authHeaders();
    const res = await fetch(CAT_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error('Could not add category (' + res.status + ')');
    return res.json();
  }

  async function deleteCategory(id) {
    const headers = await authHeaders();
    const res = await fetch(CAT_ENDPOINT, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error('Could not delete category (' + res.status + ')');
    return res.json();
  }

  return {
    fetchTransactions, importTransactions, updateTransactions, deleteTransactions,
    fetchCategories, addCategory, deleteCategory
  };
})();
