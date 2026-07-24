import { getUser } from '@netlify/identity';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
      .select('account, date, description, category, amount, fee, balance, dedupe_key')
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

  return new Response('Method not allowed', { status: 405 });
};
