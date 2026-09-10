// Vercel Serverless Function - keeps the Gemini API key server-side.
// Never call the Gemini API directly from the browser: the key would be visible
// to anyone who opens dev tools on the public site.
//
// Deploy: connect this repo to a Vercel project, set the GEMINI_API_KEY
// environment variable in the Vercel dashboard (Project Settings -> Environment
// Variables). Get a free key at https://aistudio.google.com/apikey.
// Optionally set GEMINI_MODEL to point at a different model without a code
// change (defaults to gemini-3.5-flash-lite; check
// https://ai.google.dev/gemini-api/docs/models for the current flash-lite id
// if Google has since renamed/retired this one).
//
// Free tier note: Google's free Gemini API tier may use submitted prompts and
// responses to improve their products (the paid tier does not). If sending
// real customer diagnostic text through this endpoint on a free-tier key is
// a compliance concern, attach billing to the Google Cloud project instead —
// nothing else about this integration needs to change.
//
// Request:  POST { context?: {...}, fields: { <key>: "<internal text>", ... } }
// Response: { fields: { <key>: "<polished text>", ... } }

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

// Fixed set of known field names across both report types (Diagnostic Quotation
// and Repair & Engineering Report). Only the keys actually sent in the request
// are included in the prompt/schema, and only those are expected back.
const FIELD_KEYS = ['visualInspection', 'probableCause', 'initialFindings', 'recommendedAction', 'correctiveAction', 'testResults', 'notes'];

export default async function handler(req, res) {
    // CORS: restrict this to your real site origin once you have one (set
    // ALLOWED_ORIGIN in Vercel's env vars). '*' is fine while you're still on a
    // throwaway GitHub Pages / vercel.app URL for simulation.
    const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
            return;
        }

        const { context, fields } = req.body || {};
        if (!fields || typeof fields !== 'object') {
            res.status(400).json({ error: 'fields object is required' });
            return;
        }

        const providedKeys = Object.keys(fields).filter(k => FIELD_KEYS.includes(k) && typeof fields[k] === 'string' && fields[k].trim());
        if (providedKeys.length === 0) {
            res.status(400).json({ error: 'At least one non-empty field is required' });
            return;
        }

        const equipmentLine = context
            ? [
                  [context.brand, context.model, context.itemName].filter(Boolean).join(' '),
                  context.faultDescription ? `Customer-reported fault: ${context.faultDescription}` : '',
                  context.warrantyType === 'W' ? 'This is a warranty claim.' : '',
              ].filter(Boolean).join('\n')
            : '';

        const fieldsBlock = providedKeys.map(k => `### ${k}\n${fields[k]}`).join('\n\n');

        const responseSchema = {
            type: 'OBJECT',
            properties: Object.fromEntries(providedKeys.map(k => [k, { type: 'STRING' }])),
            required: providedKeys,
        };

        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{
                            text:
                                "You are a technical writer for an industrial electronics and mechanical repair company. " +
                                "Rewrite the engineer's internal technical notes into polished, professional, customer-facing language for a formal service report. " +
                                "Keep every technical fact and finding — do not invent, omit, or soften anything material. " +
                                "Remove internal jargon, exact internal part numbers/SKUs, and internal shorthand where a customer wouldn't need them; describe components in plain terms instead. " +
                                "Keep roughly the same length per field — do not pad or ramble, and do not add sections that weren't asked for. Write in complete, professional sentences (not bullet fragments). " +
                                "Only return the fields that were provided in the input.",
                        }],
                    },
                    contents: [{
                        role: 'user',
                        parts: [{ text: `${equipmentLine}\n\nRewrite the following report sections for the customer-facing copy:\n\n${fieldsBlock}` }],
                    }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema,
                    },
                }),
            }
        );

        const data = await geminiRes.json();

        if (!geminiRes.ok) {
            res.status(geminiRes.status).json({ error: data?.error?.message || 'Gemini API error' });
            return;
        }

        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText) {
            res.status(502).json({ error: 'Gemini did not return parseable output', finishReason: data?.candidates?.[0]?.finishReason });
            return;
        }

        let parsedOutput;
        try {
            parsedOutput = JSON.parse(rawText);
        } catch (e) {
            res.status(502).json({ error: 'Gemini returned a response that was not valid JSON' });
            return;
        }

        const polished = {};
        for (const key of providedKeys) {
            if (parsedOutput[key]) polished[key] = parsedOutput[key];
        }

        res.status(200).json({ fields: polished });
    } catch (err) {
        console.error('polish-report error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}
