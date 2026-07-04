/*
 * DelhiCulture frontend — v2.
 * No framework, no build step. Fetches the JSON the engine publishes
 * and renders it. Falls back to events.json with client-side bucketing
 * if the bucket files aren't reachable, so the page never sits blank.
 *
 * New in v2 (all display-level, JSON contract unchanged):
 *   - Category + venue (institution) filters
 *   - Grid / Index view toggle (preference kept in localStorage)
 *   - Date-grouped listings in the 7-day / 30-day sections
 *   - "Worth planning for" highlights strip driven by the existing
 *     `score` field from ranking.py — no AI, no new data
 *   - Display-level category refinement: events the engine left as
 *     generic "Cultural" are re-labelled from title keywords
 *     (rule-based; the same rules should eventually migrate into
 *     normalize.py so the JSON itself improves — see IMPLEMENTATION.md)
 *   - ALL-CAPS source titles are shown in title case
 *   - Known filler images (IIC's default placeholder) treated as absent
 *   - "Ongoing · until …" marker for multi-day events spanning today
 */

(function () {
  "use strict";

  /* ---------- state ---------- */

  var state = {
    view: readPref("dc-view", "grid"), // "grid" | "list"
    category: null,                    // active category filter or null
    source: null,                      // active institution filter or null
  };

  var BUCKETS = { today: [], week: [], month: [] };

  var SECTIONS = [
    { key: "today", file: "today.json", gridId: "grid-today", groupByDate: false },
    { key: "week", file: "week.json", gridId: "grid-week", groupByDate: true },
    { key: "month", file: "month.json", gridId: "grid-month", groupByDate: true },
  ];

  /* ---------- category system ----------
     CATEGORY_HEX mirrors the --cat-* custom properties in style.css.
     Duplicated as hex because the generated monogram placeholder is an
     inline SVG data URI, which can't resolve CSS variables. Keep in
     sync with :root in style.css if the palette changes. */

  var CATEGORY_COLORS = {
    "Heritage": "--cat-heritage",
    "Archaeology": "--cat-archaeology",
    "Architecture": "--cat-architecture",
    "Urbanism": "--cat-urbanism",
    "Landscape": "--cat-landscape",
    "Museum": "--cat-museum",
    "Photography": "--cat-photography",
    "Indian Classical": "--cat-classical",
    "Jazz": "--cat-jazz",
    "Dance & Music": "--cat-dance",
    "Theatre": "--cat-theatre",
    "Film": "--cat-film",
    "Book Talk": "--cat-book",
    "Children": "--cat-children",
    "Festival": "--cat-festival",
    "Exhibition": "--cat-exhibition",
    "Talk": "--cat-talk",
  };

  var CATEGORY_HEX = {
    "Heritage": "#b0392a",
    "Archaeology": "#b3612a",
    "Architecture": "#2f5e96",
    "Urbanism": "#2f7d8c",
    "Landscape": "#3f8a4d",
    "Museum": "#ab8420",
    "Photography": "#6f56a0",
    "Indian Classical": "#b83e85",
    "Jazz": "#c77c1f",
    "Dance & Music": "#c2426f",
    "Theatre": "#7345a6",
    "Film": "#3d3d3d",
    "Book Talk": "#8a5526",
    "Children": "#d0722f",
    "Festival": "#a58722",
    "Exhibition": "#9c5a38",
    "Talk": "#4f6e8f",
  };
  var DEFAULT_HEX = "#6b6b6b";

  /* Engine categories folded into a single display/filter category.
     Applied before refinement, so the filter bar never shows near-
     duplicate chips (Dance / Music / Dance & Music, Film & Talk, …).
     These should eventually migrate into normalize.py's canonical set. */
  var CANONICAL_CATEGORIES = {
    "Dance": "Dance & Music",
    "Music": "Dance & Music",
    "Film & Talk": "Film",
    "Film & Theatre": "Theatre",
  };

  /* Display-level category refinement for events the engine labelled
     with the generic fallback. Rule-based keyword matching only —
     order matters (most specific first). */
  var GENERIC_CATEGORIES = { "Cultural": true, "": true };
  var REFINE_RULES = [
    [/\bfilms?\b|\bcinema\b|\bscreening\b/i, "Film"],
    [/\bexhibition\b|\binstallation\b/i, "Exhibition"],
    [/\bbook discussion\b|\bbook talk\b|\bpoetry\b|\bkavita\b|\bpoems?\b/i, "Book Talk"],
    [/\bkathak\b|\bbharatanatyam\b|\bodissi\b|\bkuchipudi\b|\bdance\b/i, "Dance & Music"],
    [/\barchaeolog/i, "Archaeology"],
    [/\bheritage\b/i, "Heritage"],
    [/\bphotograph/i, "Photography"],
    [/\btheatre\b|\btheater\b/i, "Theatre"],
    [/\brecitals?\b|\bconcert\b|\bchoral\b|\bmusic\b|\bpiano\b|\bsitar\b|\bsarod\b/i, "Dance & Music"],
    [/\blecture\b|\bdialogues?\b|\bdiscussion\b|\btalk\b|\bseminar\b|\bpanel\b|\bcolloquium\b/i, "Talk"],
  ];

  function refinedCategory(ev) {
    var cat = ev.category || "";
    if (CANONICAL_CATEGORIES[cat]) cat = CANONICAL_CATEGORIES[cat];
    if (!GENERIC_CATEGORIES[cat]) return cat;
    var hay = (ev.title || "") + " " + (ev.venue || "");
    for (var i = 0; i < REFINE_RULES.length; i++) {
      if (REFINE_RULES[i][0].test(hay)) return REFINE_RULES[i][1];
    }
    return "Cultural";
  }

  /* ---------- institutions ---------- */

  /* Real institution images: drop the file into docs/images/venues/ and
     map it to the collector's `source` id, NOT the literal venue string
     (IHC reports room-level venues like "The Stein Auditorium").
     fit: "cover" for photos, "contain" for logos/wordmarks. */
  var SOURCE_IMAGES = {
    bikanerhouse: { src: "images/venues/bikaner-house.jpg", fit: "contain" },
    ihc: { src: "images/venues/ihc.jpg", fit: "contain" },
    // iic: { src: "images/venues/iic.jpg", fit: "cover" },
    // ignca: { src: "images/venues/ignca.jpg", fit: "contain" },
  };

  var SOURCE_NAMES = {
    iic: "India International Centre",
    ihc: "India Habitat Centre",
    bikanerhouse: "Bikaner House",
    ignca: "IGNCA",
  };

  var SOURCE_SHORT = {
    iic: "IIC",
    ihc: "IHC",
    bikanerhouse: "Bikaner House",
    ignca: "IGNCA",
  };

  /* Known filler/default images that sources return when an event has
     no real image — treat as absent so the institution fallback chain
     kicks in instead of a generic stock frame. */
  var BAD_IMAGE_PATTERNS = ["/img/default/"];

  function realImage(ev) {
    if (!ev.image) return null;
    for (var i = 0; i < BAD_IMAGE_PATTERNS.length; i++) {
      if (ev.image.indexOf(BAD_IMAGE_PATTERNS[i]) !== -1) return null;
    }
    return ev.image;
  }

  /* ---------- boot ---------- */

  var mastheadDate = document.getElementById("masthead-date");
  if (mastheadDate) mastheadDate.textContent = formatLongDate(new Date());

  init();

  async function init() {
    var loaded = await loadBuckets();
    if (!loaded) {
      SECTIONS.forEach(function (s) { showError(s.gridId); });
      return;
    }
    buildFilterBar();
    bindViewToggle();
    bindSectionObserver();
    renderAll();
  }

  async function loadBuckets() {
    try {
      for (var i = 0; i < SECTIONS.length; i++) {
        var s = SECTIONS[i];
        var data = await fetchJSON(s.file);
        BUCKETS[s.key] = data.events || [];
        if (s.key === "today") setGeneratedAt(data.generated_at);
      }
      return true;
    } catch (err) {
      /* bucket files unreachable — fall back to the full set */
    }
    try {
      var full = await fetchJSON("events.json");
      BUCKETS = bucketClientSide(full.events || []);
      setGeneratedAt(full.generated_at);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* Wall-clock time of the last pipeline publish, read from the HTTP
     Last-Modified header GitHub Pages serves for the data files — no
     engine change needed to show an update time. */
  var LAST_MODIFIED = null;

  async function fetchJSON(file) {
    var res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(file + " " + res.status);
    if ((file === "today.json" || file === "events.json") && res.headers && res.headers.get) {
      LAST_MODIFIED = res.headers.get("last-modified") || LAST_MODIFIED;
    }
    return res.json();
  }

  function bucketClientSide(events) {
    var today = startOfDay(new Date());
    var weekEnd = addDays(today, 7);
    var monthEnd = addDays(today, 30);
    var buckets = { today: [], week: [], month: [] };

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var start = parseISODate(ev.date);
      var end = ev.end_date ? parseISODate(ev.end_date) : start;
      if (!start || !end || end < today) continue;

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

  /* ---------- filters ---------- */

  function allEvents() {
    return BUCKETS.today.concat(BUCKETS.week, BUCKETS.month);
  }

  function matchesFilter(ev) {
    if (state.category && refinedCategory(ev) !== state.category) return false;
    if (state.source && ev.source !== state.source) return false;
    return true;
  }

  function buildFilterBar() {
    var catHost = document.getElementById("filter-cats");
    var venueHost = document.getElementById("filter-venues");
    if (!catHost || !venueHost) return;

    var catCounts = {};
    var srcCounts = {};
    allEvents().forEach(function (ev) {
      var c = refinedCategory(ev);
      catCounts[c] = (catCounts[c] || 0) + 1;
      srcCounts[ev.source] = (srcCounts[ev.source] || 0) + 1;
    });

    var cats = Object.keys(catCounts).sort(function (a, b) {
      return catCounts[b] - catCounts[a] || a.localeCompare(b);
    });
    var srcs = Object.keys(srcCounts).sort(function (a, b) {
      return srcCounts[b] - srcCounts[a] || a.localeCompare(b);
    });

    catHost.innerHTML = "";
    catHost.appendChild(makeChip("All", null, "category"));
    cats.forEach(function (c) {
      catHost.appendChild(makeChip(c, c, "category", CATEGORY_HEX[c]));
    });

    venueHost.innerHTML = "";
    srcs.forEach(function (s) {
      venueHost.appendChild(makeChip(SOURCE_SHORT[s] || s, s, "source"));
    });
  }

  function makeChip(label, value, dimension, hex) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.dataset.dimension = dimension;
    if (value !== null) btn.dataset.value = value;
    if (hex) btn.style.setProperty("--chip-dot", hex);
    btn.setAttribute("aria-pressed", String(isChipActive(dimension, value)));
    btn.addEventListener("click", function () {
      var current = state[dimension];
      state[dimension] = (value !== null && current === value) ? null : value;
      syncChips();
      renderAll();
    });
    return btn;
  }

  function isChipActive(dimension, value) {
    if (value === null) return state[dimension] === null && dimension === "category";
    return state[dimension] === value;
  }

  function syncChips() {
    var chips = document.querySelectorAll(".chip");
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var dim = c.dataset.dimension;
      var val = c.dataset.value !== undefined ? c.dataset.value : null;
      c.setAttribute("aria-pressed", String(isChipActive(dim, val)));
    }
  }

  function clearFilters() {
    state.category = null;
    state.source = null;
    syncChips();
    renderAll();
  }

  /* ---------- view toggle ---------- */

  function bindViewToggle() {
    var buttons = document.querySelectorAll("[data-view]");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          state.view = btn.dataset.view;
          writePref("dc-view", state.view);
          syncViewToggle();
          renderAll();
        });
      })(buttons[i]);
    }
    syncViewToggle();
  }

  function syncViewToggle() {
    var buttons = document.querySelectorAll("[data-view]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].dataset.view === state.view));
    }
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    renderHighlights();
    SECTIONS.forEach(function (s) {
      renderSection(s);
    });
  }

  function renderSection(section) {
    var host = document.getElementById(section.gridId);
    if (!host) return;

    var events = BUCKETS[section.key].filter(matchesFilter);
    sortEvents(events);

    host.innerHTML = "";
    host.classList.remove("empty-state");

    if (!events.length) {
      host.classList.add("empty-state");
      if (state.category || state.source) {
        host.appendChild(emptyFilterNode());
      } else {
        host.textContent = host.dataset.emptyCopy || "Nothing listed here yet.";
      }
      return;
    }

    var frag = document.createDocumentFragment();

    if (section.groupByDate) {
      var groups = groupByDate(events);
      groups.forEach(function (g) {
        var h = document.createElement("h3");
        h.className = "date-heading";
        h.textContent = formatGroupDate(g.date);
        frag.appendChild(h);
        frag.appendChild(buildEventContainer(g.events));
      });
    } else {
      frag.appendChild(buildEventContainer(events));
    }

    host.appendChild(frag);
  }

  function emptyFilterNode() {
    var wrap = document.createElement("span");
    wrap.appendChild(document.createTextNode("Nothing matching this filter here. "));
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "link-reset";
    reset.textContent = "Clear filters";
    reset.addEventListener("click", clearFilters);
    wrap.appendChild(reset);
    return wrap;
  }

  function buildEventContainer(events) {
    if (state.view === "list") {
      var list = document.createElement("div");
      list.className = "index-list";
      events.forEach(function (ev) { list.appendChild(buildRow(ev)); });
      return list;
    }
    var grid = document.createElement("div");
    grid.className = "card-grid";
    events.forEach(function (ev) { grid.appendChild(buildCard(ev)); });
    return grid;
  }

  function sortEvents(events) {
    events.sort(function (a, b) {
      var d = (a.date || "").localeCompare(b.date || "");
      if (d) return d;
      var ta = parseTimeMinutes(a.time);
      var tb = parseTimeMinutes(b.time);
      if (ta !== tb) return ta - tb;
      return (b.score || 0) - (a.score || 0);
    });
  }

  function groupByDate(events) {
    var map = {};
    var order = [];
    events.forEach(function (ev) {
      var key = ev.date || "unknown";
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(ev);
    });
    return order.map(function (key) {
      return { date: key, events: map[key] };
    });
  }

  /* ---------- highlights ---------- */

  var HIGHLIGHT_MIN_SCORE = 65;
  var HIGHLIGHT_COUNT = 6;
  var HIGHLIGHT_MIN_TO_SHOW = 3;

  function renderHighlights() {
    var sectionEl = document.getElementById("highlights");
    var host = document.getElementById("grid-highlights");
    if (!sectionEl || !host) return;

    var picks = allEvents()
      .filter(function (ev) { return (ev.score || 0) >= HIGHLIGHT_MIN_SCORE; })
      .sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (a.date || "").localeCompare(b.date || "");
      })
      .slice(0, HIGHLIGHT_COUNT);

    if (picks.length < HIGHLIGHT_MIN_TO_SHOW) {
      sectionEl.hidden = true;
      return;
    }

    sectionEl.hidden = false;
    host.innerHTML = "";
    picks.forEach(function (ev) {
      host.appendChild(buildHighlightCard(ev));
    });
  }

  function buildHighlightCard(ev) {
    var a = document.createElement("a");
    a.className = "hl-card";
    a.href = ev.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    applyCategoryColor(a, ev);

    var meta = document.createElement("div");
    meta.className = "hl-card__meta";
    var cat = document.createElement("span");
    cat.className = "card__category";
    cat.textContent = refinedCategory(ev);
    var when = document.createElement("span");
    when.textContent = formatEventDate(ev);
    meta.appendChild(cat);
    meta.appendChild(when);
    a.appendChild(meta);

    var title = document.createElement("div");
    title.className = "hl-card__title";
    title.textContent = displayTitle(ev.title);
    a.appendChild(title);

    var venue = document.createElement("div");
    venue.className = "hl-card__venue";
    venue.textContent = ev.venue || "";
    a.appendChild(venue);

    return a;
  }

  /* ---------- cards (grid view) ---------- */

  function applyCategoryColor(el, ev) {
    var cat = refinedCategory(ev);
    var colorVar = CATEGORY_COLORS[cat];
    if (colorVar) el.style.setProperty("--cat-color", "var(" + colorVar + ")");
  }

  function buildCard(ev) {
    var a = document.createElement("a");
    a.className = "card";
    a.href = ev.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    applyCategoryColor(a, ev);

    var img = document.createElement("img");
    img.className = "card__image";
    img.alt = "";
    img.loading = "lazy";

    var eventImage = realImage(ev);
    var sourceEntry = SOURCE_IMAGES[ev.source];

    if (eventImage) {
      img.src = eventImage;
    } else if (sourceEntry) {
      img.src = sourceEntry.src;
      if (sourceEntry.fit === "contain") img.classList.add("card__image--contain");
    } else {
      img.src = buildFallbackImage(ev);
    }

    /* if a real image fails to load, drop to the generated placeholder —
       but never retry on the placeholder itself */
    img.onerror = function () {
      if (img.dataset.fallenBack) return;
      img.dataset.fallenBack = "1";
      img.classList.remove("card__image--contain");
      img.src = buildFallbackImage(ev);
    };
    a.appendChild(img);

    var meta = document.createElement("div");
    meta.className = "card__meta";
    var cat = document.createElement("span");
    cat.className = "card__category";
    cat.textContent = refinedCategory(ev);
    var when = document.createElement("span");
    when.textContent = metaDateText(ev);
    meta.appendChild(cat);
    meta.appendChild(when);
    a.appendChild(meta);

    var title = document.createElement("div");
    title.className = "card__title";
    title.textContent = displayTitle(ev.title);
    a.appendChild(title);

    var venue = document.createElement("div");
    venue.className = "card__venue";
    venue.textContent = ev.venue || "";
    a.appendChild(venue);

    if (ev.time) {
      var time = document.createElement("div");
      time.className = "card__time";
      time.textContent = ev.time;
      a.appendChild(time);
    }

    if (ev.description) {
      var desc = document.createElement("div");
      desc.className = "card__desc";
      desc.textContent = ev.description;
      a.appendChild(desc);
    }

    return a;
  }

  /* ---------- rows (index view) ---------- */

  function buildRow(ev) {
    var a = document.createElement("a");
    a.className = "row";
    a.href = ev.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    applyCategoryColor(a, ev);

    var meta = document.createElement("span");
    meta.className = "row__meta";
    var time = document.createElement("span");
    time.className = "row__time";
    time.textContent = isOngoing(ev) ? "Ongoing" : (ev.time || metaDateText(ev));
    var cat = document.createElement("span");
    cat.className = "row__category card__category";
    cat.textContent = refinedCategory(ev);
    meta.appendChild(time);
    meta.appendChild(cat);
    a.appendChild(meta);

    var title = document.createElement("span");
    title.className = "row__title";
    title.textContent = displayTitle(ev.title);
    a.appendChild(title);

    var venue = document.createElement("span");
    venue.className = "row__venue";
    venue.textContent = ev.venue || "";
    a.appendChild(venue);

    return a;
  }

  /* ---------- generated placeholder ---------- */

  function venueInitials(venueName) {
    return (venueName || "?")
      .split(/\s+/)
      .filter(Boolean)
      .map(function (w) { return w[0]; })
      .slice(0, 3)
      .join("")
      .toUpperCase();
  }

  function buildFallbackImage(ev) {
    var hex = CATEGORY_HEX[refinedCategory(ev)] || DEFAULT_HEX;
    var nameForInitials = SOURCE_NAMES[ev.source] || ev.venue;
    var initials = venueInitials(nameForInitials);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 338">' +
      '<rect width="600" height="338" fill="' + hex + '" fill-opacity="0.08"/>' +
      '<text x="300" y="190" font-family="IBM Plex Mono, monospace" ' +
      'font-size="72" font-weight="500" fill="' + hex + '" fill-opacity="0.55" ' +
      'text-anchor="middle" letter-spacing="4">' + initials + "</text>" +
      "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ---------- title display normalisation ----------
     Sources publish titles in wildly inconsistent casing ("FILM- If on
     a Winter's Night", "BOOK DISCUSSION GROUP  -Wild Capital"). This
     cleans the *display* only — the underlying data is untouched. */

  var SMALL_WORDS = {
    a: 1, an: 1, the: 1, of: 1, in: 1, on: 1, and: 1, or: 1,
    for: 1, to: 1, with: 1, at: 1, by: 1, from: 1, as: 1,
  };
  var KEEP_UPPER = {
    IIC: 1, IHC: 1, IGNCA: 1, MOU: 1, US: 1, USA: 1, UK: 1, UN: 1,
    ASEAN: 1, ICPR: 1, NSD: 1, KNMA: 1, NGMA: 1, AI: 1, DAG: 1,
  };

  function displayTitle(raw) {
    if (!raw) return "";
    var t = String(raw).replace(/\s+/g, " ").trim();
    t = t.replace(/[\s,;-]+$/, "");            // trailing punctuation cruft
    t = t.replace(/\s+-\s*/g, " — ");     // " - " / " -" → em dash
    t = t.replace(/^(Film|Exhibition|Performance|Talk)-\s*/i, function (m, p1) {
      return capitalize(p1) + " — ";
    });

    var letters = t.replace(/[^A-Za-z]/g, "");
    var uppers = t.replace(/[^A-Z]/g, "");
    if (letters.length > 6 && uppers.length / letters.length > 0.7) {
      t = titleCase(t);
    }
    return t;
  }

  function titleCase(str) {
    var words = str.split(" ");
    return words
      .map(function (w, i) {
        var bare = w.replace(/[^A-Za-z.]/g, "");
        if (KEEP_UPPER[bare.replace(/\./g, "")]) return w.toUpperCase();
        if (/\d/.test(w)) return w;                 // years, numbers — leave
        if (/\../.test(bare)) return w.toUpperCase(); // initials like B.G.
        var lower = w.toLowerCase();
        if (i !== 0 && i !== words.length - 1 && SMALL_WORDS[lower]) return lower;
        return capitalize(lower);
      })
      .join(" ");
  }

  function capitalize(w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  /* ---------- misc ui ---------- */

  function showError(elementId) {
    var grid = document.getElementById(elementId);
    if (!grid) return;
    grid.classList.add("empty-state");
    grid.textContent = "Couldn't load listings right now — try refreshing.";
  }

  /* ---------- release stamp ----------
     rel 1.<N> where N = days since BASELINE_DATE, driven by the data's
     generated_at — increments automatically with each day's pipeline
     run. A third component appears only on days we ship a frontend
     update: bump FRONTEND_BUILD.seq (and set .date to that day) with
     every same-day release; it drops off naturally the next day. */
  var BASELINE_DATE = "2026-07-04"; // rel 1.0
  var FRONTEND_BUILD = { date: "2026-07-04", seq: 2 };

  function releaseLabel(iso) {
    var base = parseISODate(BASELINE_DATE);
    var d = parseISODate(iso);
    if (!base || !d) return null;
    var minor = Math.max(0, Math.round((d - base) / 86400000));
    var label = "1." + minor;
    if (FRONTEND_BUILD.date === iso) label += "." + FRONTEND_BUILD.seq;
    return label;
  }

  function publishTimeIST() {
    if (!LAST_MODIFIED) return null;
    var d = new Date(LAST_MODIFIED);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString("en-IN", {
      hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
    }).toLowerCase();
  }

  function setGeneratedAt(iso) {
    if (!iso) return;
    var el = document.getElementById("footer-generated");
    if (!el) return;
    var parts = [];
    var time = publishTimeIST();
    if (time) parts.push(time);
    var rel = releaseLabel(iso);
    if (rel) parts.push("rel " + rel);
    el.textContent = "Last updated " + iso +
      (parts.length ? " (" + parts.join(" / ") + ")" : "") + ".";
  }

  /* Active state on the jump nav as sections scroll past. Guarded —
     progressive enhancement only. */
  function bindSectionObserver() {
    if (!("IntersectionObserver" in window)) return;
    var links = {};
    var anchors = document.querySelectorAll(".jumpnav a[href^='#']");
    for (var i = 0; i < anchors.length; i++) {
      links[anchors[i].getAttribute("href").slice(1)] = anchors[i];
    }
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var link = links[entry.target.id];
          if (!link) return;
          if (entry.isIntersecting) {
            for (var id in links) links[id].classList.remove("is-active");
            link.classList.add("is-active");
          }
        });
      },
      { rootMargin: "-20% 0px -60% 0px" }
    );
    for (var id in links) {
      var section = document.getElementById(id);
      if (section) observer.observe(section);
    }
  }

  /* ---------- prefs (guarded — private mode etc.) ---------- */

  function readPref(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) { /* non-fatal */ }
  }

  /* ---------- date helpers ---------- */

  function parseISODate(iso) {
    if (!iso) return null;
    var parts = iso.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(d, n) {
    var copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function isOngoing(ev) {
    if (!ev.end_date) return false;
    var start = parseISODate(ev.date);
    var end = parseISODate(ev.end_date);
    var today = startOfDay(new Date());
    return !!(start && end && start < today && end >= today);
  }

  function parseTimeMinutes(t) {
    if (!t) return 24 * 60 + 1; // untimed events sort last within a day
    var m = String(t).trim().match(/^(\d{1,2})[:.](\d{2})\s*(AM|PM)?$/i);
    if (!m) return 24 * 60 + 1;
    var h = parseInt(m[1], 10);
    var mins = parseInt(m[2], 10);
    var ap = (m[3] || "").toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return h * 60 + mins;
  }

  function formatLongDate(d) {
    return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  }

  function formatGroupDate(iso) {
    var d = parseISODate(iso);
    if (!d) return "";
    return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  }

  function formatEventDate(ev) {
    var start = parseISODate(ev.date);
    if (!start) return "";
    var opts = { day: "numeric", month: "short" };
    if (ev.end_date) {
      var end = parseISODate(ev.end_date);
      if (end) {
        return start.toLocaleDateString("en-IN", opts) + "–" + end.toLocaleDateString("en-IN", opts);
      }
    }
    return start.toLocaleDateString("en-IN", opts);
  }

  /* Right-hand meta text on cards: ongoing exhibitions read
     "Ongoing · until 7 Jul" rather than a bare range. */
  function metaDateText(ev) {
    if (isOngoing(ev)) {
      var end = parseISODate(ev.end_date);
      return "Ongoing · until " + end.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    }
    return formatEventDate(ev);
  }
})();
