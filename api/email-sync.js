// Vercel Serverless Function - pulls new mail from a user's own connected @tcssb.com
// mailbox into Supabase (table public.emails), so the app can show "you have new
// mail" without anyone needing to open a real mail client. Called by the browser
// itself: once when the Email tab opens, then on an interval while it stays open
// (see EMAIL_SYNC_ENDPOINT in index.html). A user can only ever sync their own
// mailbox - the row to read is looked up by their own verified user id, never by
// anything the client passes in.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getSupabaseAdmin, requireUser, setCorsHeaders } from './_lib/auth.js';
import { decryptSecret } from './_lib/crypto.js';

// A first-ever sync backfills only the most recent messages (not the whole mailbox
// history), and every sync caps how many messages it parses in one call so a very
// stale account can't run past the function's time limit - it just catches up over
// a few syncs instead, advancing last_uid a bit further each time.
const FIRST_SYNC_BACKFILL = 25;
const MAX_MESSAGES_PER_SYNC = 60;

export default async function handler(req, res) {
    setCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
        const user = await requireUser(req, res);
        if (!user) return;
        const admin = getSupabaseAdmin();

        const { data: account, error: acctErr } = await admin
            .from('email_accounts').select('*').eq('id', user.id).maybeSingle();
        if (acctErr) { res.status(500).json({ error: acctErr.message }); return; }
        if (!account) { res.status(400).json({ error: 'No email account connected yet' }); return; }

        const client = new ImapFlow({
            host: account.imap_host,
            port: account.imap_port,
            secure: true,
            auth: { user: account.email, pass: decryptSecret(account.encrypted_password) },
            logger: false,
        });

        let maxUidSeen = account.last_uid || 0;
        let newCount = 0;

        await client.connect();
        try {
            const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });

            if (mailbox.exists > 0) {
                const lowUid = account.last_uid
                    ? account.last_uid + 1
                    : Math.max(1, mailbox.uidNext - FIRST_SYNC_BACKFILL);

                const rows = [];
                let processed = 0;
                for await (const message of client.fetch(
                    `${lowUid}:*`,
                    { uid: true, envelope: true, source: true, flags: true },
                    { uid: true }
                )) {
                    if (account.last_uid && message.uid <= account.last_uid) continue;
                    if (message.uid > maxUidSeen) maxUidSeen = message.uid;
                    if (processed >= MAX_MESSAGES_PER_SYNC) continue;
                    processed++;

                    const parsed = await simpleParser(message.source);
                    const messageId = message.envelope?.messageId || parsed.messageId || `uid-${message.uid}@${account.imap_host}`;
                    const fromAddr = (message.envelope?.from || []).map(a => a.address).filter(Boolean).join(', ') || parsed.from?.text || '';
                    const toAddr = (message.envelope?.to || []).map(a => a.address).filter(Boolean).join(', ') || parsed.to?.text || '';
                    const subject = message.envelope?.subject || parsed.subject || '(no subject)';
                    const date = message.envelope?.date || parsed.date || new Date();
                    const bodyText = parsed.text || '';

                    rows.push({
                        id: `${user.id}:${messageId}`,
                        owner_id: user.id,
                        data: {
                            messageId, uid: message.uid, direction: 'in',
                            from: fromAddr, to: toAddr, subject,
                            date: date.toISOString(),
                            snippet: bodyText.slice(0, 240),
                            bodyText, bodyHtml: parsed.html || null,
                            isRead: message.flags?.has('\\Seen') || false,
                        },
                    });
                }

                if (rows.length) {
                    const { error: upsertErr } = await admin.from('emails')
                        .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
                    if (upsertErr) throw upsertErr;
                    newCount = rows.length;
                }
            }
        } finally {
            await client.logout().catch(() => {});
        }

        await admin.from('email_accounts')
            .update({ last_uid: maxUidSeen, last_synced_at: new Date().toISOString() })
            .eq('id', user.id);

        res.status(200).json({ ok: true, newCount });
    } catch (err) {
        console.error('email-sync error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
