// Vercel Serverless Function - sends an email as the caller's own connected
// @tcssb.com mailbox (SMTP), then logs a copy into public.emails so the sent
// message shows up in their in-app history immediately, without waiting on the
// next IMAP sync to see it in the mailbox's Sent folder.

import nodemailer from 'nodemailer';
import { getSupabaseAdmin, requireUser, setCorsHeaders } from './_lib/auth.js';
import { decryptSecret } from './_lib/crypto.js';

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const admin = getSupabaseAdmin();

        const { to, subject, text } = req.body || {};
        if (!to || !subject || !text) { res.status(400).json({ error: 'to, subject, and text are required' }); return; }

        const { data: account, error: acctErr } = await admin
            .from('email_accounts').select('*').eq('id', user.id).maybeSingle();
        if (acctErr) { res.status(500).json({ error: acctErr.message }); return; }
        if (!account) { res.status(400).json({ error: 'No email account connected yet' }); return; }

        const transporter = nodemailer.createTransport({
            host: account.smtp_host,
            port: account.smtp_port,
            secure: true,
            auth: { user: account.email, pass: decryptSecret(account.encrypted_password) },
        });

        const info = await transporter.sendMail({ from: account.email, to, subject, text });

        const messageId = info.messageId || `sent-${Date.now()}@${account.smtp_host}`;
        const nowIso = new Date().toISOString();
        await admin.from('emails').insert({
            id: `${user.id}:${messageId}`,
            owner_id: user.id,
            data: {
                messageId, direction: 'out', from: account.email, to, subject,
                date: nowIso, snippet: text.slice(0, 240), bodyText: text, bodyHtml: null, isRead: true,
            },
        });

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('email-send error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
