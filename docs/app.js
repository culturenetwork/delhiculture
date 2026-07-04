/*
 * DelhiCulture frontend — v3.
 * No framework, no build step. Fetches the JSON the engine publishes
 * and renders it. Falls back to events.json with client-side bucketing
 * if the bucket files aren't reachable, so the page never sits blank.
 * The JSON contract is unchanged from v1/v2 — the engine needs no changes.
 *
 * Carried over from v2:
 *   - Category + venue (institution) filters
 *   - Grid / Index view toggle (preference kept in localStorage)
 *   - Date-grouped listings, highlights strip, category refinement,
 *     title-case normalisation, filler-image handling, "Ongoing" marker,
 *     release stamp in the footer
 *
 * New in v3 (all display-level, JSON contract unchanged):
 *   - Instant search across title / venue / description / category
 *   - Shareable state: filters, search, lens and view live in the URL
 *   - Lead story hero — the single best-scored event with a real image
 *   - Event detail overlay: full description, map link, direct source
 *     link, add-to-calendar (.ics), save, copy-link. Cards open the
 *     overlay; the source link inside goes to the institution's page.
 *   - Saved events (star, kept in localStorage) + "Saved" lens
 *   - "This Weekend" lens
 *   - Dark mode toggle (auto via prefers-color-scheme, choice persisted)
 *   - "/" focuses search, Esc closes the overlay
 */

(function () {
  "use strict";

  /* ---------- state ---------- */

  var state = {
    view: readPref("dc-view", "grid"), // "grid" | "list"
    category: null,                    // active category filter or null
    source: null,                      // active institution filter or null
    query: "",                         // search text
    lens: "all",                       // "all" | "weekend" | "saved"
  };

  var SAVED = loadSaved();

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

  /* Engine categories folded into a single display/filter category. */
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

  /* Where "get me there" should point — venue-level address queries.
     Falls back to "<venue>, New Delhi". */
  var SOURCE_MAP_QUERY = {
    iic: "India International Centre, 40 Max Mueller Marg, New Delhi",
    ihc: "India Habitat Centre, Lodhi Road, New Delhi",
    bikanerhouse: "Bikaner House, Pandara Road, India Gate, New Delhi",
    ignca: "IGNCA, Janpath, New Delhi",
  };

  var BAD_IMAGE_PATTERNS = ["/img/default/"];

  function realImage(ev) {
    if (!ev.image) return null;
    for (var i = 0; i < BAD_IMAGE_PATTERNS.length; i++) {
      if (ev.image.indexOf(BAD_IMAGE_PATTERNS[i]) !== -1) return null;
    }
    return ev.image;
  }

  /* ---------- event identity (for saving + deep links) ---------- */

  function eventId(ev) {
    var slug = String(ev.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return (ev.date || "") + "~" + slug;
  }

  function findEventById(id) {
    var evs = allEvents();
    for (var i = 0; i < evs.length; i++) {
      if (eventId(evs[i]) === id) return evs[i];
    }
    return null;
  }

  /* ---------- saved events ---------- */

  function loadSaved() {
    try {
      var raw = window.localStorage.getItem("dc-saved");
      var arr = raw ? JSON.parse(raw) : [];
      var set = {};
      if (Object.prototype.toString.call(arr) === "[object Array]") {
        arr.forEach(function (id) { set[id] = true; });
      }
      return set;
    } catch (e) {
      return {};
    }
  }

  function persistSaved() {
    try {
      window.localStorage.setItem("dc-saved", JSON.stringify(Object.keys(SAVED)));
    } catch (e) { /* non-fatal */ }
  }

  function isSaved(ev) { return !!SAVED[eventId(ev)]; }

  function toggleSaved(ev) {
    var id = eventId(ev);
    if (SAVED[id]) delete SAVED[id];
    else SAVED[id] = true;
    persistSaved();
    syncStars(id, !!SAVED[id]);
    if (state.lens === "saved") renderAll();
  }

  function syncStars(id, on) {
    var stars = document.querySelectorAll('.star[data-id="' + cssEscape(id) + '"]');
    for (var i = 0; i < stars.length; i++) {
      stars[i].setAttribute("aria-pressed", String(on));
      stars[i].textContent = on ? "★" : "☆";
      stars[i].setAttribute("aria-label", on ? "Remove from saved" : "Save this event");
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function makeStar(ev) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "star";
    var on = isSaved(ev);
    btn.dataset.id = eventId(ev);
    btn.textContent = on ? "★" : "☆";
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", on ? "Remove from saved" : "Save this event");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      toggleSaved(ev);
    });
    return btn;
  }

  /* ---------- URL state (shareable views) ---------- */

  var URL_KEYS = { category: "cat", source: "venue", query: "q", lens: "lens", view: "view" };

  function readURLState() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("cat")) state.category = params.get("cat");
    if (params.get("venue")) state.source = params.get("venue");
    if (params.get("q")) state.query = params.get("q");
    var lens = params.get("lens");
    if (lens === "weekend" || lens === "saved") state.lens = lens;
    var view = params.get("view");
    if (view === "grid" || view === "list") state.view = view;
    return params.get("e"); // deep-linked event id, if any
  }

  function updateURL() {
    var params = new URLSearchParams();
    if (state.category) params.set(URL_KEYS.category, state.category);
    if (state.source) params.set(URL_KEYS.source, state.source);
    if (state.query) params.set(URL_KEYS.query, state.query);
    if (state.lens !== "all") params.set(URL_KEYS.lens, state.lens);
    if (openEventId) params.set("e", openEventId);
    var qs = params.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    try {
      window.history.replaceState(null, "", url);
    } catch (e) { /* file:// etc. — non-fatal */ }
  }

  /* ---------- boot ---------- */

  var mastheadDate = document.getElementById("masthead-date");
  if (mastheadDate) mastheadDate.textContent = formatLongDate(new Date());

  bindThemeToggle();
  init();

  async function init() {
    var deepLinkId = readURLState();
    var loaded = await loadBuckets();
    if (!loaded) {
      SECTIONS.forEach(function (s) { showError(s.gridId); });
      return;
    }
    buildFilterBar();
    bindViewToggle();
    bindLensChips();
    bindSearch();
    bindSectionObserver();
    bindOverlay();
    renderAll();
    if (deepLinkId) {
      var ev = findEventById(deepLinkId);
      if (ev) openDetail(ev);
    }
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
     Last-Modified header GitHub Pages serves for the data files. */
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

  /* ---------- filters, search, lenses ---------- */

  function allEvents() {
    return BUCKETS.today.concat(BUCKETS.week, BUCKETS.month);
  }

  function anyFilterActive() {
    return !!(state.category || state.source || state.query || state.lens !== "all");
  }

  function matchesQuery(ev) {
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    var hay = [
      ev.title || "",
      ev.venue || "",
      ev.description || "",
      refinedCategory(ev),
      SOURCE_NAMES[ev.source] || "",
    ].join(" ").toLowerCase();
    /* every space-separated term must appear somewhere */
    var terms = q.split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  /* The coming weekend: Saturday–Sunday (or the remainder of it if
     today already is the weekend). An event matches when its run
     overlaps those days. */
  function weekendRange() {
    var today = startOfDay(new Date());
    var day = today.getDay(); // 0 Sun … 6 Sat
    var sat, sun;
    if (day === 0) { sat = today; sun = today; }           // Sunday: just today
    else if (day === 6) { sat = today; sun = addDays(today, 1); }
    else { sat = addDays(today, 6 - day); sun = addDays(sat, 1); }
    return { start: sat, end: sun };
  }

  function matchesLens(ev) {
    if (state.lens === "saved") return isSaved(ev);
    if (state.lens === "weekend") {
      var wr = weekendRange();
      var start = parseISODate(ev.date);
      var end = ev.end_date ? parseISODate(ev.end_date) : start;
      if (!start) return false;
      if (!end) end = start;
      return start <= wr.end && end >= wr.start;
    }
    return true;
  }

  function matchesFilter(ev) {
    if (state.category && refinedCategory(ev) !== state.category) return false;
    if (state.source && ev.source !== state.source) return false;
    if (!matchesQuery(ev)) return false;
    if (!matchesLens(ev)) return false;
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
      updateURL();
      renderAll();
    });
    return btn;
  }

  function isChipActive(dimension, value) {
    if (value === null) return state[dimension] === null && dimension === "category";
    return state[dimension] === value;
  }

  function syncChips() {
    var chips = document.querySelectorAll(".chip[data-dimension]");
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
    state.query = "";
    state.lens = "all";
    var input = document.getElementById("search-input");
    if (input) input.value = "";
    syncChips();
    syncLensChips();
    updateURL();
    renderAll();
  }

  /* ---------- lens chips (All / This Weekend / Saved) ---------- */

  function bindLensChips() {
    var buttons = document.querySelectorAll("[data-lens]");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          state.lens = (state.lens === btn.dataset.lens) ? "all" : btn.dataset.lens;
          syncLensChips();
          updateURL();
          renderAll();
        });
      })(buttons[i]);
    }
    syncLensChips();
  }

  function syncLensChips() {
    var buttons = document.querySelectorAll("[data-lens]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].dataset.lens === state.lens));
    }
  }

  /* ---------- search ---------- */

  function bindSearch() {
    var input = document.getElementById("search-input");
    if (!input) return;
    if (state.query) input.value = state.query;

    var timer = null;
    input.addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        state.query = input.value.trim();
        updateURL();
        renderAll();
      }, 120);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        state.query = "";
        updateURL();
        renderAll();
        input.blur();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var t = e.target;
        var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (!typing && overlayEl && overlayEl.hidden) {
          e.preventDefault();
          input.focus();
        }
      }
    });
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

  /* ---------- theme ---------- */

  function bindThemeToggle() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var root = document.documentElement;
      var systemDark = window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      var current = root.getAttribute("data-theme") || (systemDark ? "dark" : "light");
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      writePref("dc-theme", next);
    });
  }

  /* ---------- rendering ---------- */

  function renderAll() {
    renderLead();
    renderHighlights();
    SECTIONS.forEach(function (s) {
      renderSection(s);
    });
    renderResultCount();
  }

  function renderResultCount() {
    var el = document.getElementById("result-count");
    if (!el) return;
    if (!anyFilterActive()) {
      el.hidden = true;
      return;
    }
    var n = allEvents().filter(matchesFilter).length;
    el.hidden = false;
    el.textContent = n + (n === 1 ? " listing" : " listings");
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
      if (anyFilterActive()) {
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
    var copy = "Nothing matching here. ";
    if (state.lens === "saved" && !Object.keys(SAVED).length) {
      copy = "Nothing saved yet — tap the ☆ on any listing to keep it here. ";
    } else if (state.lens === "weekend") {
      copy = "Nothing matching this weekend here. ";
    }
    wrap.appendChild(document.createTextNode(copy));
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

  /* Cards, rows and highlight cards all open the detail overlay;
     the source link lives inside it. Keyboard: Enter / Space. */
  function makeOpenable(el, ev) {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-haspopup", "dialog");
    el.addEventListener("click", function () { openDetail(ev); });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(ev);
      }
    });
  }

  /* ---------- lead story ---------- */

  var LEAD_MIN_SCORE = 70;
  var leadPickId = null;

  function pickLead() {
    var candidates = allEvents()
      .filter(function (ev) { return (ev.score || 0) >= LEAD_MIN_SCORE && realImage(ev); })
      .sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (a.date || "").localeCompare(b.date || "");
      });
    return candidates[0] || null;
  }

  function renderLead() {
    var host = document.getElementById("lead");
    if (!host) return;

    leadPickId = null;

    /* Editorial front page only — hide while searching/filtering. */
    if (anyFilterActive()) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    var ev = pickLead();
    if (!ev) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    leadPickId = eventId(ev);
    host.hidden = false;
    host.innerHTML = "";

    var card = document.createElement("article");
    card.className = "lead__card";
    applyCategoryColor(card, ev);
    makeOpenable(card, ev);

    var body = document.createElement("div");
    body.className = "lead__body";

    var eyebrow = document.createElement("div");
    eyebrow.className = "lead__eyebrow";
    eyebrow.textContent = "Today's Pick";
    body.appendChild(eyebrow);

    var meta = document.createElement("div");
    meta.className = "lead__meta";
    var cat = document.createElement("span");
    cat.className = "card__category";
    cat.textContent = refinedCategory(ev);
    var when = document.createElement("span");
    when.textContent = metaDateText(ev);
    meta.appendChild(cat);
    meta.appendChild(when);
    if (ev.time) {
      var t = document.createElement("span");
      t.textContent = ev.time;
      meta.appendChild(t);
    }
    body.appendChild(meta);

    var title = document.createElement("h2");
    title.className = "lead__title";
    title.textContent = displayTitle(ev.title);
    body.appendChild(title);

    var venue = document.createElement("div");
    venue.className = "lead__venue";
    venue.textContent = ev.venue || "";
    body.appendChild(venue);

    if (ev.description) {
      var desc = document.createElement("p");
      desc.className = "lead__desc";
      desc.textContent = ev.description;
      body.appendChild(desc);
    }

    var img = document.createElement("img");
    img.className = "lead__image";
    img.alt = "";
    img.loading = "eager";
    img.src = realImage(ev);
    img.onerror = function () {
      img.src = buildFallbackImage(ev);
    };

    card.appendChild(body);
    card.appendChild(img);
    host.appendChild(card);
  }

  /* ---------- highlights ---------- */

  var HIGHLIGHT_MIN_SCORE = 65;
  var HIGHLIGHT_COUNT = 6;
  var HIGHLIGHT_MIN_TO_SHOW = 3;

  function renderHighlights() {
    var sectionEl = document.getElementById("highlights");
    var host = document.getElementById("grid-highlights");
    if (!sectionEl || !host) return;

    /* The strip is the editorial default view. When the reader filters,
       they're searching — hide it so results aren't pushed below the
       fold (especially on mobile). */
    if (anyFilterActive()) {
      sectionEl.hidden = true;
      return;
    }

    var picks = allEvents()
      .filter(function (ev) {
        return (ev.score || 0) >= HIGHLIGHT_MIN_SCORE && eventId(ev) !== leadPickId;
      })
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
    var a = document.createElement("article");
    a.className = "hl-card";
    applyCategoryColor(a, ev);
    makeOpenable(a, ev);

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
    var a = document.createElement("article");
    a.className = "card";
    applyCategoryColor(a, ev);
    makeOpenable(a, ev);

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

    a.appendChild(makeStar(ev));

    return a;
  }

  /* ---------- rows (index view) ---------- */

  function buildRow(ev) {
    var a = document.createElement("article");
    a.className = "row";
    applyCategoryColor(a, ev);
    makeOpenable(a, ev);

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

    a.appendChild(makeStar(ev));

    return a;
  }

  /* ---------- detail overlay ---------- */

  var overlayEl = null;
  var detailEl = null;
  var lastFocus = null;
  var openEventId = null;

  function bindOverlay() {
    overlayEl = document.getElementById("overlay");
    detailEl = document.getElementById("detail");
    if (!overlayEl || !detailEl) return;

    overlayEl.addEventListener("click", function (e) {
      if (e.target === overlayEl) closeDetail();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !overlayEl.hidden) closeDetail();
    });
  }

  function mapURL(ev) {
    var q = SOURCE_MAP_QUERY[ev.source] || ((ev.venue || "Delhi") + ", New Delhi");
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }

  function shareURL(ev) {
    return window.location.origin + window.location.pathname + "?e=" +
      encodeURIComponent(eventId(ev));
  }

  function openDetail(ev) {
    if (!overlayEl || !detailEl) return;
    lastFocus = document.activeElement;
    openEventId = eventId(ev);
    updateURL();

    detailEl.innerHTML = "";
    applyCategoryColor(detailEl, ev);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "detail__close";
    close.textContent = "Esc ✕";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeDetail);
    detailEl.appendChild(close);

    var eventImage = realImage(ev);
    var sourceEntry = SOURCE_IMAGES[ev.source];
    if (eventImage || sourceEntry) {
      var img = document.createElement("img");
      img.className = "detail__image";
      img.alt = "";
      if (eventImage) {
        img.src = eventImage;
      } else {
        img.src = sourceEntry.src;
        if (sourceEntry.fit === "contain") img.classList.add("detail__image--contain");
      }
      img.onerror = function () { img.remove(); };
      detailEl.appendChild(img);
    }

    var meta = document.createElement("div");
    meta.className = "detail__meta";
    var cat = document.createElement("span");
    cat.className = "card__category";
    cat.textContent = refinedCategory(ev);
    meta.appendChild(cat);
    var when = document.createElement("span");
    when.textContent = metaDateText(ev);
    meta.appendChild(when);
    if (ev.time) {
      var t = document.createElement("span");
      t.textContent = ev.time;
      meta.appendChild(t);
    }
    detailEl.appendChild(meta);

    var title = document.createElement("h2");
    title.className = "detail__title";
    title.id = "detail-title";
    title.textContent = displayTitle(ev.title);
    detailEl.appendChild(title);

    var venue = document.createElement("div");
    venue.className = "detail__venue";
    venue.appendChild(document.createTextNode((ev.venue || "") + " · "));
    var map = document.createElement("a");
    map.href = mapURL(ev);
    map.target = "_blank";
    map.rel = "noopener noreferrer";
    map.textContent = "Map ↗";
    venue.appendChild(map);
    detailEl.appendChild(venue);

    if (ev.description) {
      var desc = document.createElement("p");
      desc.className = "detail__desc";
      desc.textContent = ev.description;
      detailEl.appendChild(desc);
    }

    var actions = document.createElement("div");
    actions.className = "detail__actions";

    if (ev.url) {
      var src = document.createElement("a");
      src.className = "btn btn--primary";
      src.href = ev.url;
      src.target = "_blank";
      src.rel = "noopener noreferrer";
      src.textContent = "Details & booking ↗";
      actions.appendChild(src);
    }

    var ics = document.createElement("button");
    ics.type = "button";
    ics.className = "btn";
    ics.textContent = "Add to calendar";
    ics.addEventListener("click", function () { downloadICS(ev); });
    actions.appendChild(ics);

    var save = document.createElement("button");
    save.type = "button";
    save.className = "btn";
    save.setAttribute("aria-pressed", String(isSaved(ev)));
    save.textContent = isSaved(ev) ? "★ Saved" : "☆ Save";
    save.addEventListener("click", function () {
      toggleSaved(ev);
      save.setAttribute("aria-pressed", String(isSaved(ev)));
      save.textContent = isSaved(ev) ? "★ Saved" : "☆ Save";
    });
    actions.appendChild(save);

    var share = document.createElement("button");
    share.type = "button";
    share.className = "btn";
    share.textContent = "Copy link";
    share.addEventListener("click", function () {
      var url = shareURL(ev);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { showToast("Link copied"); },
          function () { window.prompt("Copy this link:", url); }
        );
      } else {
        window.prompt("Copy this link:", url);
      }
    });
    actions.appendChild(share);

    detailEl.appendChild(actions);

    detailEl.setAttribute("role", "dialog");
    detailEl.setAttribute("aria-modal", "true");
    detailEl.setAttribute("aria-labelledby", "detail-title");

    overlayEl.hidden = false;
    document.body.style.overflow = "hidden";
    close.focus();
  }

  function closeDetail() {
    if (!overlayEl) return;
    overlayEl.hidden = true;
    document.body.style.overflow = "";
    openEventId = null;
    updateURL();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------- calendar export (.ics) ---------- */

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function icsDate(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function icsEscape(s) {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  function buildICS(ev) {
    var start = parseISODate(ev.date);
    if (!start) return null;
    var end = ev.end_date ? parseISODate(ev.end_date) : null;
    var mins = parseTimeMinutes(ev.time);
    var timed = mins < 24 * 60 + 1;

    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//DelhiCulture//delhiculture.com//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:" + eventId(ev).replace(/[^a-zA-Z0-9~-]/g, "") + "@delhiculture.com",
      "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
    ];

    if (timed) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var stamp = icsDate(start) + "T" + pad2(h) + pad2(m) + "00";
      /* 90-minute default duration for timed events */
      var endMins = mins + 90;
      var eh = Math.floor(endMins / 60) % 24;
      var em = endMins % 60;
      var endStamp = icsDate(start) + "T" + pad2(eh) + pad2(em) + "00";
      lines.push("DTSTART;TZID=Asia/Kolkata:" + stamp);
      lines.push("DTEND;TZID=Asia/Kolkata:" + endStamp);
    } else {
      /* all-day (or multi-day run) — DTEND is exclusive */
      var lastDay = end && end > start ? end : start;
      lines.push("DTSTART;VALUE=DATE:" + icsDate(start));
      lines.push("DTEND;VALUE=DATE:" + icsDate(addDays(lastDay, 1)));
    }

    lines.push("SUMMARY:" + icsEscape(displayTitle(ev.title)));
    if (ev.venue) lines.push("LOCATION:" + icsEscape(ev.venue + ", New Delhi"));
    var descParts = [];
    if (ev.description) descParts.push(ev.description);
    if (ev.url) descParts.push("Details: " + ev.url);
    if (descParts.length) lines.push("DESCRIPTION:" + icsEscape(descParts.join("\n\n")));
    if (ev.url) lines.push("URL:" + icsEscape(ev.url));
    lines.push("END:VEVENT");
    lines.push("END:VCALENDAR");

    /* fold long lines at 75 octets per RFC 5545 (simple char-based fold) */
    var folded = [];
    lines.forEach(function (line) {
      while (line.length > 74) {
        folded.push(line.slice(0, 74));
        line = " " + line.slice(74);
      }
      folded.push(line);
    });
    return folded.join("\r\n") + "\r\n";
  }

  function downloadICS(ev) {
    var ics = buildICS(ev);
    if (!ics) return;
    var blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "delhiculture-" + eventId(ev).replace(/[^a-zA-Z0-9-]/g, "-") + ".ics";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    showToast("Calendar file downloaded");
  }

  /* ---------- toast ---------- */

  var toastTimer = null;

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
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

  /* ---------- title display normalisation ---------- */

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
    t = t.replace(/^(Film|Exhibition|Performance|Talk)\s*[—-]\s*/i, function (m, p1) {
      return capitalize(p1.toLowerCase()) + " — ";
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
  var FRONTEND_BUILD = { date: "2026-07-04", seq: 7 }; // v3.1 cache-busting

  var COMMIT_TIME_API =
    "https://api.github.com/repos/culturenetwork/delhiculture/commits?path=docs/today.json&per_page=1";
  var triedCommitTimeApi = false;

  function fetchCommitTime(iso) {
    fetch(COMMIT_TIME_API)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        var c = list && list[0] && list[0].commit && list[0].commit.committer;
        if (c && c.date) {
          LAST_MODIFIED = c.date; // ISO UTC, e.g. 2026-07-04T06:05:15Z
          setGeneratedAt(iso);    // re-render the footer with the time
        }
      })
      .catch(function () { /* footer just shows the rel number */ });
  }

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

    if (!time && !triedCommitTimeApi) {
      triedCommitTimeApi = true;
      fetchCommitTime(iso);
    }
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
