// Vercel Serverless Function - sends an email as the caller's own connected
// @tcssb.com mailbox (SMTP), then logs a copy into public.emails so the sent
// message shows up in their in-app history immediately, without waiting on the
// next IMAP sync to see it in the mailbox's Sent folder.
//
// Attachments: the browser uploads files straight to Supabase Storage
// (bucket "email-attachments", under its own user-id folder - see
// supabase/schema.sql for the RLS policy) before calling this endpoint, and
// passes back just the storage paths. This function downloads each one
// server-side (service_role, so it can read a path outside its own RLS-visible
// scope isn't needed - the paths it's given already belong to this same user)
// and attaches it to the outgoing message.

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

        const { to, cc, subject, text, inReplyTo, attachmentPaths } = req.body || {};
        if (!to || !subject || !text) { res.status(400).json({ error: 'to, subject, and text are required' }); return; }

        const { data: account, error: acctErr } = await admin
            .from('email_accounts').select('*').eq('id', user.id).maybeSingle();
        if (acctErr) { res.status(500).json({ error: acctErr.message }); return; }
        if (!account) { res.status(400).json({ error: 'No email account connected yet' }); return; }

        // Every attachment path must live under this user's own Storage folder -
        // refuse anything else rather than letting a tampered request read another
        // user's uploaded file through this server-side download.
        const paths = Array.isArray(attachmentPaths) ? attachmentPaths : [];
        const ownPrefix = `${user.id}/`;
        const badPath = paths.find(p => typeof p !== 'string' || !p.startsWith(ownPrefix));
        if (badPath) { res.status(400).json({ error: 'Invalid attachment path' }); return; }

        const attachments = [];
        for (const path of paths) {
            const { data: file, error: downloadErr } = await admin.storage.from('email-attachments').download(path);
            if (downloadErr) { res.status(400).json({ error: `Could not read attachment ${path}: ${downloadErr.message}` }); return; }
            const buffer = Buffer.from(await file.arrayBuffer());
            attachments.push({ filename: path.split('/').pop().replace(/^\d+-/, ''), content: buffer });
        }

        const transporter = nodemailer.createTransport({
            host: account.smtp_host,
            port: account.smtp_port,
            secure: true,
            auth: { user: account.email, pass: decryptSecret(account.encrypted_password) },
        });

        const info = await transporter.sendMail({
            from: account.email, to, cc: cc || undefined, subject, text,
            inReplyTo: inReplyTo || undefined,
            references: inReplyTo || undefined,
            attachments: attachments.length ? attachments : undefined,
        });

        const messageId = info.messageId || `sent-${Date.now()}@${account.smtp_host}`;
        const nowIso = new Date().toISOString();
        await admin.from('emails').insert({
            id: `${user.id}:${messageId}`,
            owner_id: user.id,
            data: {
                messageId, direction: 'out', from: account.email, to, cc: cc || '', subject,
                date: nowIso, snippet: text.slice(0, 240), bodyText: text, bodyHtml: null, isRead: true,
                attachments: attachments.map((a, i) => ({ filename: a.filename, size: a.content.length, path: paths[i] })),
            },
        });

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('email-send error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
