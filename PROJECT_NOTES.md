# 📈 Market Pulse — Project Notes

A running, build-it-day-by-day project. This doc is the **handoff/resume guide**: what it is,
how it works, how to operate it, the gotchas we hit, and where to pick up next.

Live site: **https://cl0110.github.io/market-pulse/**
Repo: **https://github.com/CL0110/market-pulse** (public)

---

## 1. What it is
A free, self-updating **business & economic news dashboard with AI sentiment**. Three times a
day it scrapes ~700–900 headlines from quality outlets, scores each one's market sentiment with
Google Gemini, and publishes a public webpage with a "Market Mood" index, charts, search, and a
date archive. **No servers, no database, no monthly cost.**

It's a fork of the same pattern as the earlier Google-Trends scraper: **RSS feed → scheduled
GitHub Action → JSON in the repo → display layer.**

---

## 2. Architecture (how the pieces fit)
```
GitHub Actions (cloud, 3x/day, runs even if my laptop is off)
   │
   ├─ scrape_news.py
   │     ├─ fetch ~23 RSS feeds (rate-limited, retried)
   │     ├─ normalize + de-duplicate headlines
   │     ├─ score sentiment via Gemini (label / score / market-relevant)
   │     ├─ aggregate the "Market Mood" index
   │     └─ write docs/data/*.json
   │
   └─ commit the JSON back to the repo
        │
        └─ GitHub Pages serves docs/ as a static site
              └─ index.html + app.js read the JSON and render
```

**Key idea:** the Action *generates* data into the repo; GitHub Pages *serves* the `docs/`
folder. The site is 100% static (vanilla JS + Chart.js from a CDN) — it just fetches the JSON.

---

## 3. Data flow & files
```
market-pulse/
├─ scrape_news.py            # the scraper + sentiment engine (the brain)
├─ .github/workflows/news.yml# the 3x/day scheduled job
├─ docs/                     # <- GitHub Pages serves this folder
│  ├─ index.html             # page structure
│  ├─ app.js                 # fetches JSON, renders mood/charts/headlines
│  ├─ style.css              # styling
│  └─ data/
│     ├─ news_YYYY-MM-DD.json# one accumulating file per day (merged across the day's runs)
│     ├─ latest.json         # copy of the most recent day (site fetches this first)
│     └─ index.json          # manifest: every day + counts + mood (powers the trend chart)
├─ README.md
└─ PROJECT_NOTES.md          # this file
```

Each run **merges** new headlines into the current day's file (so the day's picture grows across
the 9am/1pm/6pm runs) and only scores headlines that don't already have current-version sentiment.

---

## 4. Sources (~23 feeds, all verified live)
| Category | Outlets |
|---|---|
| **Markets** | WSJ (Markets, Business), CNBC (Top, Finance), MarketWatch (Top, Real-time), Financial Times, Yahoo Finance, Seeking Alpha, Bloomberg\*, Barron's\*, Reuters\*, Google News Business |
| **Economy** | CNBC Economy, The Economist, NPR Economy, Guardian Business, Calculated Risk, Google News (inflation/Fed) |
| **Policy** | Federal Reserve, BEA, BLS\*, US Treasury\* |

\* = routed through a Google News `site:` query because the outlet's own feed is dead (Reuters)
or blocks scrapers (BLS, Treasury) or doesn't exist (Bloomberg, Barron's).

> Dropped on purpose: **Business Insider** — its feed was GlobeNewswire press-release noise.

---

## 5. The "Market Mood" index — methodology
This took a couple iterations to get honest. The final design:

1. **Every headline** → Gemini tags it `positive` / `negative` / `neutral`, a score (−1…1), and
   **`relevant`** (is it about the broad market/economy, or noise like a single-stock pitch,
   earnings-call transcript, fund commentary, PR, lottery numbers, lifestyle advice?).
2. **The index = NET ratio over market-relevant headlines only:**
   `index = (positive − negative) / (positive + negative) × 100`  →  range **−100…+100**
3. Computed **overall + per category** (Markets / Economy / Policy).

**Why this and not the obvious approach?**
- ❌ A simple *average of scores* gets washed out by the many neutral/factual headlines (a clearly
  bearish day read −7 "Neutral").
- ❌ Including *all* headlines lets noise sway it (single-stock "buy" pitches pushed Markets to a
  fake +3). ~47% of raw headlines turned out to be non-market noise.
- ✅ Net-ratio + relevance filter = the same day correctly read **−48 "Very Bearish"**, Markets
  −37. That's the honest signal.

**Read it as media *tone*, not a trading signal.** It gauges how the news *reads*; it's most
meaningful as a **trend over days** (that's the mood-over-time line chart).

Scale: `>+40` Very bullish · `>+12` Bullish · `−12…+12` Neutral/mixed · `<−12` Bearish · `<−40` Very bearish.

---

## 6. How to operate it
**It runs itself** — GitHub Actions fires at ~9am / 1pm / 6pm ET (cron `0 13,17,22 * * *` UTC).
You don't need your laptop on.

**Run it manually / on demand:** GitHub → Actions → "Market Pulse (scrape)" → Run workflow → main.

**Run locally** (for development):
```powershell
# from the repo folder
$env:GEMINI_API_KEY = "your-key"          # optional; without it, headlines are left unscored
python scrape_news.py --output-dir docs/data
python -m http.server -d docs 8000        # open http://localhost:8000
```

**The Gemini key:** stored as a GitHub **repo secret** named `GEMINI_API_KEY`
(Settings → Secrets and variables → Actions). The workflow passes it to the script as an env var.
Get a free key at https://aistudio.google.com/apikey. **Never commit the key.**

---

## 7. Config knobs (top of scrape_news.py)
| Constant | What it does |
|---|---|
| `SOURCES` | the feed list (name, category, url) — add/remove sources here |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` (high free quota; override via env `GEMINI_MODEL`) |
| `SENTIMENT_BATCH` | headlines per Gemini request (40) |
| `MAX_SCORE_PER_RUN` | cap on scoring per run (800) — protects the daily quota |
| `CIRCUIT_BREAK_FAILS` | stop scoring after N consecutive failed batches (3) — prevents hangs |
| `SENT_VERSION` | bump this to force a full re-score when you change the prompt |
| `PER_FEED_CAP` | max items kept per feed (40) |

---

## 8. Gotchas we hit (so you don't relearn them)
- **Gemini free-tier quota** is the real constraint. `flash` had too small a daily quota; `flash-lite`
  is ~4× and cleared the backlog. If a run scores little with "rate limit" notes, the quota's tapped —
  it resumes next run. The circuit breaker means it **never hangs** (we once had a 30-min hang from
  over-patient backoff — now bounded).
- **GitHub Pages** "deploy from branch" (main, `/docs`) — the *first* build takes ~3 min, not 1.
  The unauthenticated `/repos/.../pages` API returns 404 even when the site works; verify by loading
  the site URL itself.
- **Local git note (this machine):** real git is `C:\Program Files\Git\cmd\git.exe` — a broken stub
  at `C:\WINDOWS\system32\git` shadows it on PATH. `gh` CLI is not installed.
- **RSS feeds rot.** Reuters/Bloomberg/Barron's/BLS/Treasury needed Google News `site:` routing.
  Re-test feeds occasionally; a dead feed is skipped, not fatal.

---

## 9. Where to pick up next (the backlog / "way to go")
Rough ideas, not committed — pick what excites you:

**Sentiment / insight**
- [ ] Add the **daily narrative summary** ("mood today: cautious amid…") — we deferred this; Gemini
      can produce it in one extra call.
- [ ] Tune the bullish/bearish **thresholds** to taste once you've watched a few weeks of readings.
- [ ] **Per-ticker / per-topic** sentiment (e.g. track "Fed", "AI", "oil" mood separately).
- [ ] Weight headlines by **source prominence** instead of equal weight.

**Site / UX**
- [ ] Polish mobile layout; add a **dark mode**.
- [ ] **Custom domain** (e.g. marketpulse.yourdomain.com) instead of the github.io URL.
- [ ] Make headlines **collapsible by source**; show counts per outlet.
- [ ] A **"biggest movers"** strip — the most strongly positive/negative headlines of the day.

**Data**
- [ ] Add/curate more feeds; consider a few **international** sources for breadth.
- [ ] Smarter **de-duplication** (cluster near-identical stories across outlets).
- [ ] Pull a couple **hard economic indicators** (FRED API) alongside the news.

**Ops**
- [ ] Bump the schedule to more runs/day if you want it fresher.
- [ ] Add a tiny **status badge** / "last updated" health check.

---

## 10. Quick reference
- **Live site:** https://cl0110.github.io/market-pulse/
- **Run a scrape:** Actions → Market Pulse (scrape) → Run workflow
- **Check a run's result:** Actions tab → click the run → "scrape" job logs
- **Change sources / tuning:** edit `scrape_news.py`, commit, push
- **The site auto-redeploys** whenever data or `docs/` changes.
