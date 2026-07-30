import { getUser } from '@netlify/identity';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Mirrors dedupeKey() in app.js exactly, so edits to account/date/amount/
// description keep the dedupe index meaningful instead of going stale.
function dedupeKey(t) {
  const raw = [
    String(t.account || '').trim().toLowerCase(),
    t.date,
    Number(t.amount).toFixed(2),
    String(t.description || '').trim().toLowerCase().slice(0, 60)
  ].join('|');
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}

const EDITABLE_FIELDS = ['account', 'date', 'description', 'category', 'amount', 'fee', 'balance'];
const REHASH_FIELDS = ['account', 'date', 'description', 'amount'];

// This function is the only thing that ever talks to Supabase.
// It uses the service role key (kept secret, server-side only),
// so the anon/public key never has to leave the server, and the
// browser never gets direct database access.
export default async (req, context) => {
  const user = await getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, account, date, description, category, amount, fee, balance, dedupe_key')
      .eq('user_id', user.id)
      .order('date', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    return Response.json({ transactions: data });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const incoming = Array.isArray(body.transactions) ? body.transactions : [];
    if (incoming.length === 0) return Response.json({ inserted: 0, skipped: 0 });

    const rows = incoming
      .filter(t => t && t.date && t.dedupe_key && typeof t.amount === 'number')
      .map(t => ({
        user_id: user.id,
        account: String(t.account || 'Default').slice(0, 120),
        date: t.date,
        description: String(t.description || '').slice(0, 500),
        category: String(t.category || 'Uncategorised').slice(0, 80),
        amount: t.amount,
        fee: typeof t.fee === 'number' ? t.fee : 0,
        balance: typeof t.balance === 'number' ? t.balance : null,
        dedupe_key: t.dedupe_key,
      }));

    // The unique index on (user_id, account, dedupe_key) is what actually
    // guarantees no duplicate transaction is ever stored twice, even if
    // this function is called concurrently or the same file is imported
    // again from a different device.
    const { data, error } = await supabase
      .from('transactions')
      .upsert(rows, { onConflict: 'user_id,account,dedupe_key', ignoreDuplicates: true })
      .select('dedupe_key');

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    const inserted = data ? data.length : 0;
    return Response.json({ inserted, skipped: rows.length - inserted });
  }

  // Edit one or more transactions (manual correction / recategorization,
  // including bulk recategorize from the ledger UI).
  // Body: { ids: [1,2,...], patch: { category?, description?, date?, amount?, account?, fee?, balance? } }
  if (req.method === 'PATCH') {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    const patchIn = body.patch || {};
    if (ids.length === 0) return Response.json({ error: 'No ids given' }, { status: 400 });

    const update = {};
    for (const k of EDITABLE_FIELDS) if (patchIn[k] !== undefined) update[k] = patchIn[k];
    if (Object.keys(update).length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    const needsRehash = REHASH_FIELDS.some(k => k in update);

    if (!needsRehash) {
      const { error } = await supabase.from('transactions').update(update).eq('user_id', user.id).in('id', ids);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ updated: ids.length });
    }

    // Rehashing needs each row's current values merged with the patch,
    // so fetch first, then upsert the merged rows by primary key.
    const { data: current, error: fetchErr } = await supabase
      .from('transactions').select('*').eq('user_id', user.id).in('id', ids);
    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });

    const rows = current.map(r => {
      const merged = { ...r, ...update };
      merged.dedupe_key = dedupeKey(merged);
      return merged;
    });
    const { error } = await supabase.from('transactions').upsert(rows, { onConflict: 'id' });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ updated: rows.length });
  }

  // Delete one or more transactions. Body: { ids: [1,2,...] }
  if (req.method === 'DELETE') {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const ids = Array.isArray(body.ids) ? body.ids : (body.id != null ? [body.id] : []);
    if (ids.length === 0) return Response.json({ error: 'No ids given' }, { status: 400 });

    const { error } = await supabase.from('transactions').delete().eq('user_id', user.id).in('id', ids);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ deleted: ids.length });
  }

  return new Response('Method not allowed', { status: 405 });
};
