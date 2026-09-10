// Encrypts/decrypts each user's own email account password before it's stored in
// Supabase (table public.email_accounts). The key never touches the database - only
// this server-side code and the Vercel env var that holds it ever see plaintext.
//
// Deploy: set EMAIL_CREDENTIALS_KEY in Vercel -> Project Settings -> Environment
// Variables to the output of `openssl rand -base64 32`. Losing/rotating this key
// makes every already-stored email password undecryptable - affected users would
// need to reconnect their mailbox.

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const getKey = () => {
    const raw = process.env.EMAIL_CREDENTIALS_KEY;
    if (!raw) {
        throw new Error(
            'Server is missing EMAIL_CREDENTIALS_KEY. Generate one with `openssl rand -base64 32` ' +
            'and add it in Vercel -> Project Settings -> Environment Variables, then redeploy.'
        );
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw new Error('EMAIL_CREDENTIALS_KEY must decode to exactly 32 bytes (base64 of `openssl rand -base64 32`).');
    }
    return key;
};

// Output packs iv + authTag + ciphertext into one base64 string so the DB column
// stays a single opaque text value.
export const encryptSecret = (plaintext) => {
    const key = getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
};

export const decryptSecret = (packed) => {
    const key = getKey();
    const buf = Buffer.from(packed, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};
