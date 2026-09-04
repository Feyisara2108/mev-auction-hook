# Pitch Deck — LP-Governed MEV Auction Hook

A self-contained web slide deck (`index.html`, built with Reveal.js via CDN — no build step).
Open it locally by double-clicking `index.html`, or deploy it to Vercel for a shareable submission link.

**Navigate:** arrow keys ← →, `Esc` for slide overview, `F` for fullscreen.

## Deploy to Vercel (gives you the submission link)

### Option A — Vercel CLI (fastest)
```bash
cd pitch-deck
npx vercel        # first run: log in + accept defaults
npx vercel --prod # promote to the production URL you submit
```
When asked "In which directory is your code located?", accept `./` — this folder is the whole site.

### Option B — Vercel dashboard (no CLI)
1. Push this repo to GitHub (already the plan).
2. On vercel.com → **Add New… → Project** → import `Feyisara2108/mev-auction-hook`.
3. Set **Root Directory** to `pitch-deck`.
4. Framework preset: **Other** (it's a static site). Click **Deploy**.
5. Copy the resulting `https://….vercel.app` link — that's what you submit.

No configuration, environment variables, or build command are needed — it's a single static HTML file.
