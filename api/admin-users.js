// Vercel Serverless Function - creates and deletes real Supabase Auth login accounts.
// Requires the SERVICE ROLE key, which can bypass Row Level Security entirely - it must
// never reach the browser. Every request here is re-verified server-side: we take the
// caller's own session token, confirm it's valid, and confirm their profile role is
// 'superadmin' BEFORE doing anything privileged. Never trust a role the client claims.
//
// Deploy: set these two environment variables in the Vercel project (Project Settings ->
// Environment Variables), alongside the existing ANTHROPIC_API_KEY:
//   SUPABASE_URL              same value as SUPABASE_URL in index.html
//   SUPABASE_SERVICE_ROLE_KEY from Supabase Dashboard -> Project Settings -> API ->
//                              "service_role" secret key. NEVER put this in index.html,
//                              NEVER commit it, NEVER paste it into chat.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

export default async function handler(req, res) {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
        // 1. Verify the caller is a real, currently-logged-in user.
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

        const { data: callerData, error: callerErr } = await supabaseAdmin.auth.getUser(token);
        if (callerErr || !callerData?.user) { res.status(401).json({ error: 'Invalid or expired session' }); return; }

        // 2. Verify that user is a superadmin, per the database, not per anything the client sent.
        const { data: callerProfile, error: profileErr } = await supabaseAdmin
            .from('profiles').select('role').eq('id', callerData.user.id).single();
        if (profileErr || !callerProfile || callerProfile.role !== 'superadmin') {
            res.status(403).json({ error: 'Only a superadmin can manage user accounts' });
            return;
        }

        const { action } = req.body || {};

        if (action === 'create') {
            const { email, name, role, status, restrictions, password } = req.body || {};
            if (!email || !name || !password) { res.status(400).json({ error: 'email, name, and password are required' }); return; }
            if (password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }

            const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
                email, password, email_confirm: true,
            });
            if (createErr) { res.status(400).json({ error: createErr.message }); return; }

            const { data: profile, error: insertErr } = await supabaseAdmin
                .from('profiles')
                .insert({ id: created.user.id, email, name, role: role || 'engineer', status: status || 'Active', restrictions: restrictions || {} })
                .select().single();
            if (insertErr) {
                // Don't leave an orphan login with no profile behind if this half fails.
                await supabaseAdmin.auth.admin.deleteUser(created.user.id).catch(() => {});
                res.status(500).json({ error: insertErr.message });
                return;
            }
            res.status(200).json({ profile });
            return;
        }

        if (action === 'delete') {
            const { id } = req.body || {};
            if (!id) { res.status(400).json({ error: 'id is required' }); return; }
            if (id === callerData.user.id) { res.status(400).json({ error: 'You cannot delete your own account.' }); return; }
            const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(id);
            if (delErr) { res.status(500).json({ error: delErr.message }); return; }
            // The profiles row cascades via its `on delete cascade` foreign key to auth.users.
            res.status(200).json({ ok: true });
            return;
        }

        res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
        console.error('admin-users error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}
