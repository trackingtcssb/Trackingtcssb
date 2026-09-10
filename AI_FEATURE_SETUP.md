# AI report-polishing feature — setup

## What this adds

The **"AI-Polish from Internal"** buttons on the Diagnostic Quotation Report and
the Repair & Engineering Report tabs (customer view) now send the engineer's
internal notes to Gemini and get back a professionally rewritten,
customer-facing version — instead of just copying the raw internal text
verbatim like before.

## Why a serverless function is required

Gemini API calls need a secret API key. This site is (for now) a static page
with no backend, and it's public on GitHub Pages. If the frontend called the
Gemini API directly, the key would sit in plain JavaScript that anyone can read
from their browser's dev tools — and once that key leaks, someone else can run
up your bill (or exhaust your free quota). `api/polish-report.js` is a small
serverless function that holds the key server-side; the browser only ever
talks to that function.

## One-time setup (Vercel)

1. **Push this repo to GitHub** if it isn't already (it needs `index.html`,
   `api/polish-report.js`, and `package.json` all present).
2. **Sign up / log in at [vercel.com](https://vercel.com)** with your GitHub
   account.
3. **"Add New Project"** → import this repo. Vercel auto-detects the
   `api/` folder as serverless functions and serves `index.html` as the static
   site — no build configuration needed.
4. **Before the first deploy (or after, in Project Settings → Environment
   Variables)**, add:
   - `GEMINI_API_KEY` = a free key from
     [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (sign
     in with any Google account, click "Create API key")
   - *(optional)* `GEMINI_MODEL` = a different model id if the default
     (`gemini-2.5-flash-lite`) is ever renamed or retired — check
     [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
     for the current flash-lite model id and set this without touching code.
   - *(optional)* `ALLOWED_ORIGIN` = your site's exact URL, once you have a
     stable one (e.g. `https://turbocontrolsolutions.vercel.app` or your real
     domain). Leave unset for now — it defaults to allowing any origin, which
     is fine while you're still on a throwaway `.vercel.app` URL for
     simulation.
5. **Deploy.** Vercel gives you a URL like
   `https://turbo-control-solutions-website.vercel.app`.

That's it — because `index.html` requests `/api/polish-report` as a relative
path, it works automatically once both are on the same Vercel project. You do
not need to edit any code for this step.

## If you keep the frontend on GitHub Pages instead

If you want the *page* to stay on GitHub Pages long-term and only the
*function* on Vercel, the relative path won't reach across origins. In
`index.html`, find:

```js
const POLISH_REPORT_ENDPOINT = "/api/polish-report";
```

and change it to the function's full Vercel URL:

```js
const POLISH_REPORT_ENDPOINT = "https://your-app.vercel.app/api/polish-report";
```

Then set `ALLOWED_ORIGIN` in Vercel to your GitHub Pages URL exactly (e.g.
`https://trackingtcssb.github.io`) so the function's CORS check allows it.

## Cost note

Every click of "AI-Polish from Internal" is one Gemini API call (model:
`gemini-2.5-flash-lite`, Google's cheapest/fastest tier). On a free API key
this costs nothing, within Google's free-tier rate limits (currently on the
order of 15 requests/minute and 1,000/day for this model — plenty for how
often this button gets clicked). It only runs when someone explicitly clicks
the button, never automatically.

**Free tier data-use note:** Google's free Gemini API tier may use submitted
prompts and responses to improve their products; the paid tier does not.
The text sent here is internal engineering notes (equipment details, fault
descriptions) — not customer PII beyond what's already in those notes — but
if that's a concern for your business, attach a billing account to the
Google Cloud project the API key belongs to (Gemini API pricing is very low,
and this feature is only called on-demand) and the same key stops being
"free tier" without any code change.
