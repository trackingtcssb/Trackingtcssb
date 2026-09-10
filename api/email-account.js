// Vercel Serverless Function - lets a logged-in user connect their own @tcssb.com
// mailbox to the app (cPanel IMAP/SMTP, not a vendor API). The password never
// reaches the browser again after this call: it's encrypted here (see _lib/crypto.js)
// and stored in Supabase, and only ever decrypted server-side by email-sync.js /
// email-send.js to act on that same user's behalf.
//
// Deploy: alongside SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (see admin-users.js)
// and EMAIL_CREDENTIALS_KEY (see _lib/crypto.js), no extra env vars are required -
// each user supplies their own mailbox host/username/password through the UI.

import { ImapFlow } from 'imapflow';
import { getSupabaseAdmin, requireUser, setCorsHeaders } from './_lib/auth.js';
import { encryptSecret } from './_lib/crypto.js';

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const admin = getSupabaseAdmin();
        const { action } = req.body || {};

        if (action === 'connect') {
            const { email, password, imapHost, imapPort, smtpHost, smtpPort } = req.body || {};
            if (!email || !password || !imapHost || !smtpHost) {
                res.status(400).json({ error: 'email, password, imapHost, and smtpHost are required' });
                return;
            }

            // Prove the credentials actually work before storing anything - a typo'd
            // password would otherwise fail silently at the next sync, minutes later.
            const client = new ImapFlow({
                host: imapHost, port: Number(imapPort) || DEFAULT_IMAP_PORT, secure: true,
                auth: { user: email, pass: password }, logger: false,
            });
            try {
                await client.connect();
                await client.logout();
            } catch (err) {
                res.status(400).json({ error: `Could not log in to ${imapHost} as ${email}: ${err.message}` });
                return;
            }

            const { error: upsertErr } = await admin.from('email_accounts').upsert({
                id: user.id,
                email,
                imap_host: imapHost,
                imap_port: Number(imapPort) || DEFAULT_IMAP_PORT,
                smtp_host: smtpHost,
                smtp_port: Number(smtpPort) || DEFAULT_SMTP_PORT,
                encrypted_password: encryptSecret(password),
                last_uid: 0,
                last_synced_at: null,
            });
            if (upsertErr) { res.status(500).json({ error: upsertErr.message }); return; }
            res.status(200).json({ ok: true });
            return;
        }

        if (action === 'disconnect') {
            const { error } = await admin.from('email_accounts').delete().eq('id', user.id);
            if (error) { res.status(500).json({ error: error.message }); return; }
            res.status(200).json({ ok: true });
            return;
        }

        res.status(400).json({ error: 'Unknown action' });
    } catch (err) {
        console.error('email-account error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
