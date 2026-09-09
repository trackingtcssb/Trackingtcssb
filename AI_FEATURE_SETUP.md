# AI report-polishing feature — setup

## What this adds

The **"AI-Polish from Internal"** buttons on the Diagnostic Quotation Report and
the Repair & Engineering Report tabs (customer view) now send the engineer's
internal notes to Claude and get back a professionally rewritten,
customer-facing version — instead of just copying the raw internal text
verbatim like before.

## Why a serverless function is required

Claude API calls need a secret API key. This site is (for now) a static page
with no backend, and it's public on GitHub Pages. If the frontend called the
Claude API directly, the key would sit in plain JavaScript that anyone can read
from their browser's dev tools — and once that key leaks, someone else can run
up your bill. `api/polish-report.js` is a small serverless function that holds
the key server-side; the browser only ever talks to that function.

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
   - `ANTHROPIC_API_KEY` = your Claude API key (from
     [console.anthropic.com](https://console.anthropic.com))
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

Every click of "AI-Polish from Internal" is one Claude API call (model:
`claude-opus-5`, low effort, short output — typically a fraction of a cent).
It only runs when someone explicitly clicks the button, never automatically.
