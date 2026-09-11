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
const FIRST_SYNC_BACKFILL = 15;
const MAX_MESSAGES_PER_SYNC = 20;
// Wall-clock budget for the fetch loop, comfortably inside this function's maxDuration
// (see vercel.json). Downloading a message's full source, parsing it and pushing its
// attachments into Storage is slow enough that a busy mailbox could otherwise run past
// the platform limit and get killed mid-request - the browser sees no response at all
// ("Load failed"), and because nothing is ever saved the same messages are retried and
// time out again on every poll. Stopping early instead saves what was fetched and lets
// the next poll pick up from there.
const SYNC_TIME_BUDGET_MS = 35000;
// Attachments bigger than this are left out of a synced message entirely (noted via
// `skippedAttachments`) rather than blowing up Storage usage or the function's time
// budget on one oversized file.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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
            // Without these an unreachable or silent mail server is waited on indefinitely
            // until the platform kills the whole request, which reaches the browser as a
            // bare network failure with nothing to act on. These turn that into a normal
            // error response naming what went wrong.
            connectionTimeout: 15000,
            greetingTimeout: 10000,
            socketTimeout: 30000,
        });

        // ImapFlow is an EventEmitter: an async connection error with no 'error' listener
        // is thrown as an uncaught exception, taking the process down before the handler's
        // own try/catch can turn it into a response.
        client.on('error', err => console.error('IMAP client error:', err));

        let maxUidSeen = account.last_uid || 0;
        let newCount = 0;
        let reachedLimit = false;
        const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

        await client.connect();
        try {
            const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });

            if (mailbox.exists > 0) {
                const lowUid = account.last_uid
                    ? account.last_uid + 1
                    : Math.max(1, mailbox.uidNext - FIRST_SYNC_BACKFILL);

                const rows = [];
                for await (const message of client.fetch(
                    `${lowUid}:*`,
                    { uid: true, envelope: true, source: true, flags: true },
                    { uid: true }
                )) {
                    if (account.last_uid && message.uid <= account.last_uid) continue;

                    // Stop rather than skip: last_uid is only advanced for messages actually
                    // stored below, so anything left here is picked up by the next sync.
                    // (Skipping while still advancing last_uid silently dropped every message
                    // past the cap — they were never stored and never looked at again.)
                    if (rows.length >= MAX_MESSAGES_PER_SYNC || Date.now() > deadline) {
                        reachedLimit = true;
                        break;
                    }

                    const parsed = await simpleParser(message.source);
                    const messageId = message.envelope?.messageId || parsed.messageId || `uid-${message.uid}@${account.imap_host}`;
                    const fromAddr = (message.envelope?.from || []).map(a => a.address).filter(Boolean).join(', ') || parsed.from?.text || '';
                    const toAddr = (message.envelope?.to || []).map(a => a.address).filter(Boolean).join(', ') || parsed.to?.text || '';
                    const ccAddr = (message.envelope?.cc || []).map(a => a.address).filter(Boolean).join(', ') || parsed.cc?.text || '';
                    const subject = message.envelope?.subject || parsed.subject || '(no subject)';
                    const date = message.envelope?.date || parsed.date || new Date();
                    const bodyText = parsed.text || '';
                    const rowId = `${user.id}:${messageId}`;

                    // Upload each attachment to private Storage (path starts with the
                    // owner's own id, matching the RLS policy in schema.sql) rather than
                    // stuffing raw file bytes into the emails.data jsonb column.
                    let skippedAttachments = 0;
                    const attachments = [];
                    for (const [idx, att] of (parsed.attachments || []).entries()) {
                        if (!att.content || att.content.length > MAX_ATTACHMENT_BYTES) { skippedAttachments++; continue; }
                        const safeName = (att.filename || `attachment-${idx + 1}`).replace(/[\/\\]/g, '_');
                        const path = `${user.id}/${encodeURIComponent(messageId)}/${idx}-${safeName}`;
                        const { error: uploadErr } = await admin.storage
                            .from('email-attachments')
                            .upload(path, att.content, { contentType: att.contentType || 'application/octet-stream', upsert: true });
                        if (uploadErr) { console.error('Attachment upload failed:', uploadErr); skippedAttachments++; continue; }
                        attachments.push({ filename: safeName, contentType: att.contentType || 'application/octet-stream', size: att.content.length, path });
                    }

                    rows.push({
                        id: rowId,
                        owner_id: user.id,
                        data: {
                            messageId, uid: message.uid, direction: 'in',
                            from: fromAddr, to: toAddr, cc: ccAddr, subject,
                            date: date.toISOString(),
                            snippet: bodyText.slice(0, 240),
                            bodyText, bodyHtml: parsed.html || null,
                            isRead: message.flags?.has('\\Seen') || false,
                            attachments, skippedAttachments,
                        },
                    });

                    if (message.uid > maxUidSeen) maxUidSeen = message.uid;
                }

                if (rows.length) {
                    const { error: upsertErr } = await admin.from('emails')
                        .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
                    if (upsertErr) throw upsertErr;
                    newCount = rows.length;
                }
            }
        } finally {
            // A clean logout can stall when the fetch stream was abandoned part-way through
            // (the break above), so it gets a short window before the socket is just closed -
            // otherwise the tidy-up itself could hold the request open past the time limit.
            await Promise.race([
                client.logout().catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 3000)),
            ]);
            client.close();
        }

        await admin.from('email_accounts')
            .update({ last_uid: maxUidSeen, last_synced_at: new Date().toISOString() })
            .eq('id', user.id);

        res.status(200).json({ ok: true, newCount, more: reachedLimit });
    } catch (err) {
        console.error('email-sync error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
