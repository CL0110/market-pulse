/* Market Pulse — static front-end. Reads JSON produced by scrape_news.py. */
"use strict";

const state = {
  items: [],        // current day's items
  category: "All",
  sentiment: "All",
  query: "",
  charts: {},
};

const $ = (sel) => document.querySelector(sel);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireControls();
  try {
    const [latest, index] = await Promise.all([
      fetchJSON("data/latest.json"),
      fetchJSON("data/index.json"),
    ]);
    populateArchive(index, latest.date);
    drawMoodChart(index);
    loadDay(latest);
  } catch (err) {
    $("#updated").textContent = "Could not load data yet — check back after the first run.";
    console.error(err);
  }
}

async function fetchJSON(url) {
  // cache-bust so a freshly-pushed update shows without a hard refresh
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function wireControls() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.category = btn.dataset.cat;
      render();
    });
  });
  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
  $("#sentiment").addEventListener("change", (e) => {
    state.sentiment = e.target.value;
    render();
  });
  $("#archive").addEventListener("change", async (e) => {
    const date = e.target.value;
    const data = await fetchJSON(`data/news_${date}.json`);
    loadDay(data);
  });
}

function populateArchive(index, currentDate) {
  const sel = $("#archive");
  sel.innerHTML = "";
  (index.days || []).forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.date;
    opt.textContent = `${d.date} (${d.count})`;
    if (d.date === currentDate) opt.selected = true;
    sel.appendChild(opt);
  });
}

function loadDay(data) {
  state.items = data.items || [];
  $("#updated").textContent =
    `${data.date} · ${data.count} headlines · updated ${data.generated_et || ""}`;
  renderMood(data.mood);
  drawSourceChart(state.items);
  drawKeywordChart(state.items);
  render();
}

/* ---- market mood ---- */
function moodColor(idx) {
  if (idx === null || idx === undefined) return "var(--muted)";
  if (idx > 8) return "#16a34a";
  if (idx < -8) return "#dc2626";
  return "#6b7280";
}
function moodWord(idx) {
  if (idx === null || idx === undefined) return "Sentiment pending";
  if (idx > 25) return "Very bullish";
  if (idx > 8) return "Bullish";
  if (idx < -25) return "Very bearish";
  if (idx < -8) return "Bearish";
  return "Neutral / mixed";
}

function renderMood(mood) {
  const o = (mood && mood.overall) || { index: null };
  const val = $("#moodValue");
  val.textContent = o.index === null || o.index === undefined ? "—" : (o.index > 0 ? "+" + o.index : o.index);
  val.style.color = moodColor(o.index);
  $("#moodLabel").textContent = `Market Mood — ${moodWord(o.index)}`;
  if (o.scored) {
    $("#moodBreakdown").innerHTML =
      `<span class="mood-pos">▲ ${o.positive} positive</span> · ` +
      `<span class="mood-neg">▼ ${o.negative} negative</span> · ` +
      `<span class="mood-neu">● ${o.neutral} neutral</span> &nbsp;<span style="color:var(--muted)">(${o.scored} scored)</span>`;
  } else {
    $("#moodBreakdown").textContent = "Sentiment will appear after the next scored run.";
  }

  const cats = ["Markets", "Economy", "Policy"];
  $("#moodCats").innerHTML = cats.map((c) => {
    const m = (mood && mood[c]) || { index: null, positive: 0, negative: 0, neutral: 0, scored: 0 };
    const tot = Math.max(1, (m.positive || 0) + (m.negative || 0) + (m.neutral || 0));
    const pPct = (100 * (m.positive || 0) / tot).toFixed(1);
    const nPct = (100 * (m.negative || 0) / tot).toFixed(1);
    const shown = m.index === null || m.index === undefined ? "—" : (m.index > 0 ? "+" + m.index : m.index);
    return `<div class="mood-cat">
      <div class="name">${c}</div>
      <div class="val" style="color:${moodColor(m.index)}">${shown}</div>
      <div class="bar"><i class="p" style="width:${pPct}%"></i><i class="n" style="width:${nPct}%"></i></div>
    </div>`;
  }).join("");
}

function render() {
  const list = state.items.filter((it) => {
    if (state.category !== "All" && it.category !== state.category) return false;
    if (state.sentiment !== "All") {
      const lbl = (it.sentiment && it.sentiment.label) || "neutral";
      if (lbl !== state.sentiment) return false;
    }
    if (state.query) {
      const hay = `${it.title} ${it.source} ${it.summary}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  });

  $("#resultMeta").textContent =
    `Showing ${list.length} of ${state.items.length} headlines` +
    (state.category !== "All" ? ` in ${state.category}` : "") +
    (state.sentiment !== "All" ? ` · ${state.sentiment}` : "") +
    (state.query ? ` matching “${state.query}”` : "");

  const box = $("#headlines");
  if (!list.length) {
    box.innerHTML = `<p class="empty">No headlines match.</p>`;
    return;
  }
  box.innerHTML = list.map(itemHTML).join("");
}

function itemHTML(it) {
  const time = fmtTime(it.published);
  const summary = it.summary ? `<p class="summary">${escapeHTML(it.summary)}</p>` : "";
  const lbl = (it.sentiment && it.sentiment.label) || "neutral";
  const dot = `<span class="sent-dot sent-${lbl}" title="${lbl}${it.sentiment ? " (" + it.sentiment.score + ")" : ""}"></span>`;
  return `
    <article class="item ${it.category}">
      <a class="title" href="${escapeAttr(it.url)}" target="_blank" rel="noopener">${escapeHTML(it.title)}</a>
      ${summary}
      <div class="meta">
        ${dot}
        <span class="badge ${it.category}">${it.category}</span>
        <span class="src">${escapeHTML(it.source)}</span>
        ${time ? `<span class="time">· ${time}</span>` : ""}
      </div>
    </article>`;
}

/* ---- charts ---- */
function drawMoodChart(index) {
  const days = [...(index.days || [])].reverse(); // oldest -> newest
  const vals = days.map((d) => (d.mood && d.mood.overall ? d.mood.overall.index : null));
  upsertChart("chartMood", {
    type: "line",
    data: {
      labels: days.map((d) => d.date.slice(5)),
      datasets: [{
        data: vals,
        borderColor: "#1f6feb",
        backgroundColor: "rgba(31,111,235,.10)",
        fill: true, tension: .3, pointRadius: 3,
        pointBackgroundColor: vals.map((v) => v === null ? "#cbd5e1" : v > 8 ? "#16a34a" : v < -8 ? "#dc2626" : "#6b7280"),
        spanGaps: true,
      }],
    },
    options: {
      ...baseOpts(),
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { suggestedMin: -100, suggestedMax: 100, grid: { color: "#f0f0f0" }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

function drawSourceChart(items) {
  const counts = tally(items.map((i) => i.source));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 7);
  upsertChart("chartSources", {
    type: "bar",
    data: {
      labels: top.map((t) => t[0]),
      datasets: [{ data: top.map((t) => t[1]), backgroundColor: "#16a34a" }],
    },
    options: { ...baseOpts(), indexAxis: "y" },
  });
}

const STOP = new Set(("the a an and or of to in on for with at by from as is are was be "
  + "this that it its has have will after over into new us u.s. amid says say said "
  + "more most than then but not you your we they he she his her up down out off "
  + "about can could would should may might per via vs i ii inc co corp data report").split(" "));

function drawKeywordChart(items) {
  const words = {};
  items.forEach((it) => {
    it.title.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).forEach((w) => {
      if (w.length < 4 || STOP.has(w)) return;
      words[w] = (words[w] || 0) + 1;
    });
  });
  const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 8);
  upsertChart("chartKeywords", {
    type: "bar",
    data: {
      labels: top.map((t) => t[0]),
      datasets: [{ data: top.map((t) => t[1]), backgroundColor: "#b45309" }],
    },
    options: { ...baseOpts(), indexAxis: "y" },
  });
}

function baseOpts() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } },
              y: { grid: { color: "#f0f0f0" }, ticks: { font: { size: 10 }, precision: 0 } } },
  };
}

function upsertChart(id, config) {
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(document.getElementById(id), config);
}

/* ---- helpers ---- */
function tally(arr) { return arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}); }

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function escapeHTML(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function escapeAttr(s) { return (s || "").replace(/"/g, "&quot;"); }
