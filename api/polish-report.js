// Vercel Serverless Function - keeps the Anthropic API key server-side.
// Never call the Claude API directly from the browser: the key would be visible
// to anyone who opens dev tools on the public site.
//
// Deploy: connect this repo to a Vercel project, set the ANTHROPIC_API_KEY
// environment variable in the Vercel dashboard (Project Settings -> Environment
// Variables), then deploy. Vercel auto-detects /api/*.js as serverless functions.
//
// Request:  POST { context?: {...}, fields: { <key>: "<internal text>", ... } }
// Response: { fields: { <key>: "<polished text>", ... } }

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

// Fixed set of known field names across both report types (Diagnostic Quotation
// and Repair & Engineering Report). All optional - only the keys actually sent
// in the request are included in the prompt, and only those are expected back.
const PolishedFieldsSchema = z.object({
    visualInspection: z.string().optional(),
    probableCause: z.string().optional(),
    initialFindings: z.string().optional(),
    recommendedAction: z.string().optional(),
    correctiveAction: z.string().optional(),
    testResults: z.string().optional(),
    notes: z.string().optional(),
});

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the function's environment

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
        const { context, fields } = req.body || {};
        if (!fields || typeof fields !== 'object') {
            res.status(400).json({ error: 'fields object is required' });
            return;
        }

        const providedKeys = Object.keys(fields).filter(k => typeof fields[k] === 'string' && fields[k].trim());
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

        const response = await client.messages.parse({
            model: 'claude-opus-5',
            max_tokens: 4096,
            thinking: { type: 'adaptive' },
            output_config: {
                effort: 'low',
                format: zodOutputFormat(PolishedFieldsSchema),
            },
            system:
                "You are a technical writer for an industrial electronics and mechanical repair company. " +
                "Rewrite the engineer's internal technical notes into polished, professional, customer-facing language for a formal service report. " +
                "Keep every technical fact and finding — do not invent, omit, or soften anything material. " +
                "Remove internal jargon, exact internal part numbers/SKUs, and internal shorthand where a customer wouldn't need them; describe components in plain terms instead. " +
                "Keep roughly the same length per field — do not pad or ramble, and do not add sections that weren't asked for. Write in complete, professional sentences (not bullet fragments). " +
                "Only return the fields that were provided in the input.",
            messages: [
                {
                    role: 'user',
                    content: `${equipmentLine}\n\nRewrite the following report sections for the customer-facing copy:\n\n${fieldsBlock}`,
                },
            ],
        });

        if (!response.parsed_output) {
            res.status(502).json({ error: 'Claude did not return parseable output', stop_reason: response.stop_reason });
            return;
        }

        const polished = {};
        for (const key of providedKeys) {
            if (response.parsed_output[key]) polished[key] = response.parsed_output[key];
        }

        res.status(200).json({ fields: polished });
    } catch (err) {
        console.error('polish-report error:', err);
        if (err instanceof Anthropic.APIError) {
            res.status(err.status || 500).json({ error: err.message });
            return;
        }
        res.status(500).json({ error: 'Internal server error' });
    }
}
