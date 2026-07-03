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

  const CATEGORY_COLORS = {
    "Heritage": "--cat-heritage",
    "Archaeology": "--cat-archaeology",
    "Architecture": "--cat-architecture",
    "Urbanism": "--cat-urbanism",
    "Landscape": "--cat-landscape",
    "Museum": "--cat-museum",
    "Photography": "--cat-photography",
    "Indian Classical": "--cat-classical",
    "Jazz": "--cat-jazz",
    "Dance": "--cat-dance",
    "Theatre": "--cat-theatre",
    "Film": "--cat-film",
    "Book Talk": "--cat-book",
    "Children": "--cat-children",
    "Festival": "--cat-festival",
  };

  // Same palette as CATEGORY_COLORS above, but as real hex values rather
  // than CSS variable names — needed because the generated placeholder
  // below is an inline SVG data URI, which can't see the page's CSS and
  // so can't resolve var(--cat-heritage) etc. Keep these in sync with
  // the :root values in style.css if the palette ever changes.
  const CATEGORY_HEX = {
    "Heritage": "#a13a2e",
    "Archaeology": "#a15c2e",
    "Architecture": "#35577d",
    "Urbanism": "#3d6e78",
    "Landscape": "#4c7a52",
    "Museum": "#9c7d2e",
    "Photography": "#6b5a8a",
    "Indian Classical": "#a1447a",
    "Jazz": "#b8752b",
    "Dance": "#b04a72",
    "Theatre": "#6a4d8f",
    "Film": "#4a4a4a",
    "Book Talk": "#7a5230",
    "Children": "#c0703f",
    "Festival": "#957a2e",
  };
  const DEFAULT_HEX = "#6b6b6b";

  // Real venue images go here — drop the file into docs/images/venues/
  // and add an entry mapping the EXACT venue string (as it appears in
  // events.json) to it. `fit: "cover"` for real photos (fills the frame,
  // crops edges — looks best for photography). `fit: "contain"` for
  // logos/wordmarks (shown in full on a white background — cropping a
  // logo can cut off part of the mark or make text illegible). Venue
  // name must match exactly, including punctuation — check events.json
  // if a mapping doesn't seem to apply.
  const VENUE_IMAGES = {
    "Bikaner House": { src: "images/venues/bikaner-house.jpg", fit: "contain" },
    // "India International Centre": { src: "images/venues/iic.jpg", fit: "cover" },
    // "India Habitat Centre": { src: "images/venues/ihc.jpg", fit: "cover" },
  };

  function venueInitials(venueName) {
    return (venueName || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 3)
      .join("")
      .toUpperCase();
  }

  function buildFallbackImage(venueName, category) {
    const hex = CATEGORY_HEX[category] || DEFAULT_HEX;
    const initials = venueInitials(venueName);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 338">' +
      '<rect width="600" height="338" fill="' + hex + '" fill-opacity="0.08"/>' +
      '<text x="300" y="190" font-family="IBM Plex Mono, monospace" ' +
      'font-size="72" font-weight="500" fill="' + hex + '" fill-opacity="0.55" ' +
      'text-anchor="middle" letter-spacing="4">' + initials + '</text>' +
      "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function buildCard(ev) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = ev.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const colorVar = CATEGORY_COLORS[ev.category];
    if (colorVar) {
      a.style.setProperty("--cat-color", "var(" + colorVar + ")");
    }

    const img = document.createElement("img");
    img.className = "card__image";
    img.alt = "";
    img.loading = "lazy";

    const venueEntry = VENUE_IMAGES[ev.venue];

    if (ev.image) {
      img.src = ev.image;
    } else if (venueEntry) {
      img.src = venueEntry.src;
      if (venueEntry.fit === "contain") {
        img.classList.add("card__image--contain");
      }
    } else {
      img.src = buildFallbackImage(ev.venue, ev.category);
    }

    // if a REAL image (event photo or venue image) fails to load, drop
    // to the generated placeholder rather than leaving a broken icon —
    // but never retry on the placeholder itself, or a bad category/venue
    // combo could loop.
    img.onerror = function () {
      if (img.dataset.fallenBack) return;
      img.dataset.fallenBack = "1";
      img.classList.remove("card__image--contain");
      img.src = buildFallbackImage(ev.venue, ev.category);
    };
    a.appendChild(img);

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
