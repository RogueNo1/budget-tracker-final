import { getUser } from '@netlify/identity';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// User-defined category types, on top of the built-in ones baked into
// CATEGORY_RULES / CAT_COLORS in app.js. Same pattern as transactions.mjs:
// the browser never talks to Supabase directly.
export default async (req, context) => {
  const user = await getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('categories')
      .select('id, name')
      .eq('user_id', user.id)
      .order('name');
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ categories: data });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return Response.json({ error: 'Name required' }, { status: 400 });

    const { data, error } = await supabase
      .from('categories')
      .upsert({ user_id: user.id, name }, { onConflict: 'user_id,name', ignoreDuplicates: true })
      .select('id, name');
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ category: (data && data[0]) || { name } });
  }

  if (req.method === 'DELETE') {
    let body;
    try { body = await req.json(); } catch { body = {}; }
    if (body.id == null) return Response.json({ error: 'id required' }, { status: 400 });

    const { error } = await supabase.from('categories').delete().eq('user_id', user.id).eq('id', body.id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ deleted: true });
  }

  return new Response('Method not allowed', { status: 405 });
};
