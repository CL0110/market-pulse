#!/usr/bin/env python3
"""
Market Pulse — daily business & economic news aggregator.

Forks the proven Google-Trends pattern: pull a bunch of RSS feeds, normalize +
de-duplicate, and write JSON that a static GitHub Pages site renders. No API keys.

Sources (all verified live; the dead/blocked ones are routed through Google News
`site:` queries so we still get the outlet):
  Markets  : CNBC (Top, Finance), MarketWatch (Top, Real-time), FT, Google News
             Business, Reuters (via Google News)
  Economy  : CNBC Economy, Calculated Risk, Google News inflation/Fed
  Policy   : Federal Reserve, BEA, BLS (via Google News), Treasury (via Google News)

Output (into --output-dir, default ./docs/data/):
  news_YYYY-MM-DD.json   one accumulating snapshot per day (merged across the day's runs)
  latest.json            copy of the most recent day (the site fetches this first)
  index.json             manifest: every available day + counts + last-updated

Runs 3x/day via GitHub Actions; each run MERGES new headlines into today's file so
the day's picture grows instead of being overwritten. Exit 0 = ok, 1 = failure.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import logging
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# --- sources ----------------------------------------------------------------
SOURCES = [
    # Markets / business
    {"name": "CNBC Top News",        "category": "Markets", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},
    {"name": "CNBC Finance",         "category": "Markets", "url": "https://www.cnbc.com/id/10000664/device/rss/rss.html"},
    {"name": "MarketWatch Top",      "category": "Markets", "url": "http://feeds.marketwatch.com/marketwatch/topstories/"},
    {"name": "MarketWatch Realtime", "category": "Markets", "url": "http://feeds.marketwatch.com/marketwatch/realtimeheadlines/"},
    {"name": "Financial Times",      "category": "Markets", "url": "https://www.ft.com/rss/home"},
    {"name": "Google News: Business","category": "Markets", "url": "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en"},
    {"name": "Reuters",              "category": "Markets", "url": "https://news.google.com/rss/search?q=(business+OR+economy+OR+markets)+site:reuters.com+when:2d&hl=en-US&gl=US&ceid=US:en"},
    # Economy
    {"name": "CNBC Economy",         "category": "Economy", "url": "https://www.cnbc.com/id/20910258/device/rss/rss.html"},
    {"name": "Calculated Risk",      "category": "Economy", "url": "https://www.calculatedriskblog.com/feeds/posts/default?alt=rss"},
    {"name": "Google News: Inflation/Fed", "category": "Economy", "url": "https://news.google.com/rss/search?q=(inflation+OR+%22federal+reserve%22+OR+%22interest+rates%22)+when:1d&hl=en-US&gl=US&ceid=US:en"},
    # Policy / government releases
    {"name": "Federal Reserve",      "category": "Policy",  "url": "https://www.federalreserve.gov/feeds/press_all.xml"},
    {"name": "BEA",                  "category": "Policy",  "url": "https://apps.bea.gov/rss/rss.xml"},
    {"name": "BLS",                  "category": "Policy",  "url": "https://news.google.com/rss/search?q=site:bls.gov+when:7d&hl=en-US&gl=US&ceid=US:en"},
    {"name": "US Treasury",          "category": "Policy",  "url": "https://news.google.com/rss/search?q=site:treasury.gov+when:7d&hl=en-US&gl=US&ceid=US:en"},
]

# --- configuration ----------------------------------------------------------
TIMEZONE = ZoneInfo("America/New_York")  # US East Coast, auto EST/EDT
RATE_LIMIT_SECONDS = 1.5
MAX_RETRIES = 4
BACKOFF_BASE = 2.0
REQUEST_TIMEOUT = 25
PER_FEED_CAP = 40            # keep at most N newest items per feed
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
ATOM = "{http://www.w3.org/2005/Atom}"

log = logging.getLogger("market-pulse")


# --- networking (rate limit + exponential backoff) --------------------------
_last_request_at = 0.0


def _rate_limit() -> None:
    global _last_request_at
    wait = RATE_LIMIT_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def fetch(url: str) -> bytes | None:
    """Fetch a URL with retries. Returns None if all attempts fail (one dead
    feed must not sink the whole run)."""
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES):
        _rate_limit()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
            backoff = BACKOFF_BASE ** attempt
            log.warning("  attempt %d/%d failed: %s — retry in %.1fs",
                        attempt + 1, MAX_RETRIES, exc, backoff)
            if attempt < MAX_RETRIES - 1:
                time.sleep(backoff)
    log.error("  giving up on %s (%s)", url, last_exc)
    return None


# --- parsing ----------------------------------------------------------------
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _clean(text: str | None, limit: int = 280) -> str:
    if not text:
        return ""
    text = html.unescape(_TAG_RE.sub(" ", text))
    text = _WS_RE.sub(" ", text).strip()
    return text[:limit]


def _norm_title(title: str) -> str:
    """Normalize for de-duplication: lowercase, strip outlet suffix & punctuation."""
    t = title.lower()
    t = re.sub(r"\s+-\s+[^-]+$", "", t)          # drop trailing " - Outlet"
    t = re.sub(r"[^a-z0-9 ]", "", t)
    return _WS_RE.sub(" ", t).strip()


def _parse_date(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        d = parsedate_to_datetime(raw)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(TIMEZONE).isoformat()
    except (TypeError, ValueError, IndexError):
        return ""


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def parse_feed(xml_bytes: bytes, source: dict) -> list[dict]:
    """Parse RSS or Atom into normalized item dicts."""
    root = ET.fromstring(xml_bytes)
    items = root.findall(".//item")
    is_atom = not items
    if is_atom:
        items = root.findall(f".//{ATOM}entry")

    out: list[dict] = []
    for it in items[:PER_FEED_CAP]:
        if is_atom:
            title = _text(it.find(f"{ATOM}title"))
            link_el = it.find(f"{ATOM}link")
            link = link_el.get("href") if link_el is not None else ""
            summary = _text(it.find(f"{ATOM}summary")) or _text(it.find(f"{ATOM}content"))
            pub = _text(it.find(f"{ATOM}updated")) or _text(it.find(f"{ATOM}published"))
        else:
            title = _text(it.find("title"))
            link = _text(it.find("link"))
            summary = _text(it.find("description"))
            pub = _text(it.find("pubDate"))
        if not title or not link:
            continue
        # Google News puts the real outlet in <source>; native feeds use config name.
        src_el = it.find("source")
        outlet = _text(src_el) if src_el is not None and src_el.text else source["name"]
        # Google News titles end in " - Outlet"; trim it for cleanliness.
        clean_title = re.sub(r"\s+-\s+[^-]+$", "", title) if src_el is not None else title
        out.append({
            "title": _clean(clean_title, 200),
            "url": link,
            "source": outlet,
            "feed": source["name"],
            "category": source["category"],
            "published": _parse_date(pub),
            "summary": _clean(summary),
        })
    return out


# --- aggregation ------------------------------------------------------------
def collect() -> list[dict]:
    all_items: list[dict] = []
    for src in SOURCES:
        log.info("Fetching %s (%s)", src["name"], src["category"])
        raw = fetch(src["url"])
        if raw is None:
            continue
        try:
            parsed = parse_feed(raw, src)
            log.info("  %d items", len(parsed))
            all_items.extend(parsed)
        except ET.ParseError as exc:
            log.error("  parse error for %s: %s", src["name"], exc)
    return all_items


def dedupe(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        key = _norm_title(it["title"])
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def merge_with_existing(new_items: list[dict], day_path: Path) -> list[dict]:
    """Merge today's new headlines with whatever earlier runs already saved."""
    existing: list[dict] = []
    if day_path.exists():
        try:
            existing = json.loads(day_path.read_text(encoding="utf-8")).get("items", [])
        except (json.JSONDecodeError, OSError):
            existing = []
    merged = dedupe(existing + new_items)
    merged.sort(key=lambda x: x.get("published", ""), reverse=True)
    return merged


# --- output -----------------------------------------------------------------
def write_outputs(items: list[dict], out_dir: Path, date: str, generated: str) -> None:
    by_cat: dict[str, int] = {}
    for it in items:
        by_cat[it["category"]] = by_cat.get(it["category"], 0) + 1

    day_payload = {
        "date": date,
        "generated_et": generated,
        "count": len(items),
        "by_category": by_cat,
        "items": items,
    }
    day_file = out_dir / f"news_{date}.json"
    day_file.write_text(json.dumps(day_payload, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "latest.json").write_text(json.dumps(day_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    # Rebuild the manifest from all day files on disk.
    days = []
    for f in sorted(out_dir.glob("news_*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            days.append({"date": d.get("date"), "count": d.get("count", 0),
                         "by_category": d.get("by_category", {})})
        except (json.JSONDecodeError, OSError):
            continue
    days.sort(key=lambda x: x["date"] or "", reverse=True)
    index = {"last_updated_et": generated, "days": days}
    (out_dir / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("Wrote %d items -> %s (and latest.json, index.json)", len(items), day_file.name)


# --- main -------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scrape business & economic news -> JSON for a static site")
    parser.add_argument("--output-dir", default="./docs/data/", help="Where to write JSON (the site reads this)")
    args = parser.parse_args(argv)

    out_dir = Path(args.output_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stderr)],
    )

    now = dt.datetime.now(TIMEZONE)
    date = now.strftime("%Y-%m-%d")
    generated = now.strftime("%Y-%m-%d %H:%M %Z")

    log.info("=== Market Pulse run: %s ===", generated)
    try:
        new_items = dedupe(collect())
        if not new_items:
            log.error("No items collected from any feed — aborting without overwrite")
            return 1
        merged = merge_with_existing(new_items, out_dir / f"news_{date}.json")
        write_outputs(merged, out_dir, date, generated)
        log.info("=== OK: %d new this run, %d total today ===", len(new_items), len(merged))
        return 0
    except Exception as exc:  # noqa: BLE001
        log.exception("Run FAILED: %s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
