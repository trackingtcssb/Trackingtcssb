// Shared "who is calling, and are they really logged in" check, reused by every
// email-* function. Mirrors the pattern already used in api/admin-users.js: take
// the caller's own session token and re-verify it server-side rather than trusting
// anything the client claims about itself.

import { createClient } from '@supabase/supabase-js';

let supabaseAdmin = null;
export const getSupabaseAdmin = () => {
    if (supabaseAdmin) return supabaseAdmin;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error(
            'Server is missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. ' +
            'Add both in Vercel -> Project Settings -> Environment Variables, then redeploy.'
        );
    }
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    return supabaseAdmin;
};

// Returns the authenticated user, or null (and already-written 401 response) if the
// token is missing/invalid.
export const requireUser = async (req, res) => {
    const admin = getSupabaseAdmin();
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Missing auth token' }); return null; }
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) { res.status(401).json({ error: 'Invalid or expired session' }); return null; }
    return data.user;
};

export const setCorsHeaders = (req, res) => {
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};
