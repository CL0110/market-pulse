/* Market Pulse — static front-end. Reads JSON produced by scrape_news.py. */
"use strict";

const state = {
  items: [],        // current day's items
  category: "All",
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
    drawTimeChart(index);
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
  drawSourceChart(state.items);
  drawKeywordChart(state.items);
  render();
}

function render() {
  const list = state.items.filter((it) => {
    if (state.category !== "All" && it.category !== state.category) return false;
    if (state.query) {
      const hay = `${it.title} ${it.source} ${it.summary}`.toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  });

  $("#resultMeta").textContent =
    `Showing ${list.length} of ${state.items.length} headlines` +
    (state.category !== "All" ? ` in ${state.category}` : "") +
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
  return `
    <article class="item ${it.category}">
      <a class="title" href="${escapeAttr(it.url)}" target="_blank" rel="noopener">${escapeHTML(it.title)}</a>
      ${summary}
      <div class="meta">
        <span class="badge ${it.category}">${it.category}</span>
        <span class="src">${escapeHTML(it.source)}</span>
        ${time ? `<span class="time">· ${time}</span>` : ""}
      </div>
    </article>`;
}

/* ---- charts ---- */
function drawTimeChart(index) {
  const days = [...(index.days || [])].reverse(); // oldest -> newest
  upsertChart("chartTime", {
    type: "line",
    data: {
      labels: days.map((d) => d.date.slice(5)),
      datasets: [{
        data: days.map((d) => d.count),
        borderColor: "#1f6feb", backgroundColor: "rgba(31,111,235,.12)",
        fill: true, tension: .3, pointRadius: 2,
      }],
    },
    options: baseOpts(),
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
