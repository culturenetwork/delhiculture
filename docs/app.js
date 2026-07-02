/*
 * DelhiCulture frontend.
 * No framework, no build step — fetches the JSON the engine publishes
 * and renders it. If today.json/week.json/month.json aren't reachable
 * (e.g. you're testing before the pipeline has run), it falls back to
 * events.json and buckets client-side so the page never sits blank.
 */

(function () {
  "use strict";

  const SECTIONS = [
    { id: "grid-today", file: "today.json" },
    { id: "grid-week", file: "week.json" },
    { id: "grid-month", file: "month.json" },
  ];

  document.getElementById("masthead-date").textContent = formatLongDate(new Date());

  init();

  async function init() {
    let usedFallback = false;

    for (const section of SECTIONS) {
      try {
        const data = await fetchJSON(section.file);
        renderGrid(section.id, data.events || []);
        if (section.file === "today.json") setGeneratedAt(data.generated_at);
      } catch (err) {
        usedFallback = true;
        break;
      }
    }

    if (usedFallback) {
      await renderFromFullSetFallback();
    }
  }

  async function fetchJSON(file) {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(file + " " + res.status);
    return res.json();
  }

  async function renderFromFullSetFallback() {
    try {
      const data = await fetchJSON("events.json");
      const buckets = bucketClientSide(data.events || []);
      renderGrid("grid-today", buckets.today);
      renderGrid("grid-week", buckets.week);
      renderGrid("grid-month", buckets.month);
      setGeneratedAt(data.generated_at);
    } catch (err) {
      for (const section of SECTIONS) {
        showError(section.id);
      }
    }
  }

  function bucketClientSide(events) {
    const today = startOfDay(new Date());
    const weekEnd = addDays(today, 7);
    const monthEnd = addDays(today, 30);
    const buckets = { today: [], week: [], month: [] };

    for (const ev of events) {
      const start = parseISODate(ev.date);
      const end = ev.end_date ? parseISODate(ev.end_date) : start;
      if (!start || end < today) continue;

      if (start <= today && today <= end) {
        buckets.today.push(ev);
      } else if (start > today && start <= weekEnd) {
        buckets.week.push(ev);
      } else if (start > weekEnd && start <= monthEnd) {
        buckets.month.push(ev);
      }
    }
    return buckets;
  }

  function renderGrid(elementId, events) {
    const grid = document.getElementById(elementId);
    if (!grid) return;

    if (!events.length) {
      grid.innerHTML = "";
      grid.classList.add("empty-state");
      grid.textContent = grid.dataset.emptyCopy || "Nothing listed here yet.";
      return;
    }

    grid.classList.remove("empty-state");
    grid.innerHTML = "";

    const frag = document.createDocumentFragment();
    for (const ev of events) {
      frag.appendChild(buildCard(ev));
    }
    grid.appendChild(frag);
  }

  function buildCard(ev) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = ev.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    if (ev.image) {
      const img = document.createElement("img");
      img.className = "card__image";
      img.src = ev.image;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = function () { img.remove(); };
      a.appendChild(img);
    }

    const meta = document.createElement("div");
    meta.className = "card__meta";
    meta.innerHTML =
      '<span class="card__category">' + escapeHTML(ev.category || "") + "</span>" +
      "<span>" + escapeHTML(formatEventDate(ev)) + "</span>";
    a.appendChild(meta);

    const title = document.createElement("div");
    title.className = "card__title";
    title.textContent = ev.title || "";
    a.appendChild(title);

    const venue = document.createElement("div");
    venue.className = "card__venue";
    venue.textContent = ev.venue || "";
    a.appendChild(venue);

    if (ev.time) {
      const time = document.createElement("div");
      time.className = "card__time";
      time.textContent = ev.time;
      a.appendChild(time);
    }

    if (ev.description) {
      const desc = document.createElement("div");
      desc.className = "card__desc";
      desc.textContent = ev.description;
      a.appendChild(desc);
    }

    return a;
  }

  function showError(elementId) {
    const grid = document.getElementById(elementId);
    if (!grid) return;
    grid.classList.add("empty-state");
    grid.textContent = "Couldn't load listings right now — try refreshing.";
  }

  function setGeneratedAt(iso) {
    if (!iso) return;
    const el = document.getElementById("footer-generated");
    if (el) el.textContent = "Last updated " + iso + ".";
  }

  /* ---------- date helpers ---------- */

  function parseISODate(iso) {
    if (!iso) return null;
    const parts = iso.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function formatLongDate(d) {
    return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  }

  function formatEventDate(ev) {
    const start = parseISODate(ev.date);
    if (!start) return "";
    const opts = { day: "numeric", month: "short" };
    if (ev.end_date) {
      const end = parseISODate(ev.end_date);
      if (end) return start.toLocaleDateString("en-IN", opts) + "\u2013" + end.toLocaleDateString("en-IN", opts);
    }
    return start.toLocaleDateString("en-IN", opts);
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
