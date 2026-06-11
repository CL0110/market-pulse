# 📈 Market Pulse

Daily **business & economic news**, aggregated from quality RSS feeds and published as a free static website.

**Live site:** _enable GitHub Pages (Settings → Pages → Deploy from a branch → `main` / `/docs`), then it's at_ `https://<user>.github.io/market-pulse/`

## How it works
```
GitHub Actions (3x/day) → scrape_news.py → docs/data/*.json → GitHub Pages site
```
- **No API keys, no servers, no cost.** Pure RSS + a static page.
- Runs at ~9am / 1pm / 6pm ET. Each run merges new headlines into the day's file.

## Sources
| Category | Outlets |
|---|---|
| Markets | CNBC (Top, Finance), MarketWatch (Top, Real-time), Financial Times, Google News Business, Reuters\* |
| Economy | CNBC Economy, Calculated Risk, Google News (inflation / Fed) |
| Policy  | Federal Reserve, BEA, BLS\*, US Treasury\* |

\* Reuters, BLS and Treasury are routed through Google News `site:` queries because their own feeds are dead or block scrapers.

## Run it locally
```bash
python scrape_news.py --output-dir docs/data
# then serve the site:
python -m http.server -d docs 8000   # open http://localhost:8000
```

## Files
- `scrape_news.py` — the aggregator (RSS → normalized, de-duplicated JSON)
- `docs/` — the static site (`index.html`, `app.js`, `style.css`) + `data/` JSON
- `.github/workflows/news.yml` — the 3x/day scheduled job
