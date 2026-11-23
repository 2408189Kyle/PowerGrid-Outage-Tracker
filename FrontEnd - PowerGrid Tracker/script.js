"use strict";

/* =========================================================
   PowerGrid Outage Tracker
   One shared list of outages drives the map, the stats,
   the admin board and the network simulation.
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// If index.html is an older copy, stop with a clear message instead of half-working.
const REQUIRED_IDS = ["stat-active", "outage-card", "manage-button", "event-log", "toasts", "report-next", "post-announcement", "logout-button", "user-name"];
const missingIds = REQUIRED_IDS.filter((id) => !document.getElementById(id));
if (missingIds.length) {
    document.body.insertAdjacentHTML(
        "afterbegin",
        '<div style="position:fixed;inset:20px 20px auto 128px;z-index:9999;padding:16px 20px;border-radius:12px;color:#fff;background:#9f1239;font:14px Arial">' +
            "index.html is an old copy. Replace it with the newest index.html (missing: " + missingIds.join(", ") + ")." +
            "</div>"
    );
    throw new Error("Outdated index.html, missing ids: " + missingIds.join(", "));
}

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// Who is logged in (auth.js sends everyone else to login.html)
const user = Auth.currentUser();
if (!user) throw new Error("Not logged in");
const isStaff = user.role === "admin";
document.body.classList.toggle("is-staff", isStaff);
$("#user-avatar").textContent = user.name.trim().charAt(0).toUpperCase();
$("#user-name").textContent = user.name;
$("#user-name").title = user.email;
$("#user-role").textContent = isStaff ? "Staff" : `Resident · ${user.barangay}`;

/* ---------- data ---------- */
const STATUS_ORDER = ["reported", "verified", "repair", "restored"];
const STATUS_LABEL = { reported: "Reported", verified: "Verified", repair: "Under Repair", restored: "Restored" };
const ETA_BY_STATUS = { reported: "TBD", verified: "~1h 30m", repair: "~45m", restored: "Restored" };

function estimateRestoration(outage) {
    if (outage.status === "restored") return "Restored";
    const baseMinutes = { reported: 150, verified: 90, repair: 40 }[outage.status] || 150;
    const workloadMinutes = Math.round(Math.max(0, Number(outage.households) || 0) * 0.6);
    const minutes = baseMinutes + workloadMinutes;
    return `~${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function outageRisk(barangay) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = outages.filter((o) => o.barangay === barangay && Date.parse(o.createdAt || "") >= cutoff);
    const active = recent.filter((o) => o.status !== "restored").length;
    return Math.min(95, Math.max(5, 10 + recent.length * 12 + active * 18));
}

// Coordinates are approximate sample positions. feeder = which simulated feeder powers the barangay.
const BARANGAYS = {
    "Poblacion":         { coords: [13.7567, 121.0583], feeder: 0 },
    "Alangilan":         { coords: [13.7810, 121.0638], feeder: 0 },
    "Pallocan West":     { coords: [13.7648, 121.0415], feeder: 1 },
    "Kumintang Ibaba":   { coords: [13.7485, 121.0512], feeder: 1 },
    "Bolbok":            { coords: [13.7722, 121.0528], feeder: 2 },
    "Sta. Rita Karsada": { coords: [13.7460, 121.0690], feeder: 2 }
};
try {
    const savedAreas = JSON.parse(localStorage.getItem("powergrid_areas"));
    const validAreas = Array.isArray(savedAreas)
        ? savedAreas.filter((area) => area && typeof area.name === "string" && Array.isArray(area.coords) && Number.isInteger(area.feeder))
        : [];
    if (validAreas.length) {
        Object.keys(BARANGAYS).forEach((name) => delete BARANGAYS[name]);
        validAreas.forEach((area) => {
            BARANGAYS[area.name] = { coords: area.coords, feeder: Math.max(0, Math.min(2, area.feeder)) };
        });
    }
} catch {
    // Keep the built-in barangay list when saved data is invalid.
}

const feeders = [0, 1, 2].map(() => ({ online: true, latency: 18, loss: 0 }));
const outages = [];
let nextId = 1;
let selectedId = 1;
let filter = "all";
let lastChangedId = null;
let map = null;
let markerLayer = null;
const mapArea = $("#map-area");
let mapPlaceholder = null;
let mapFullscreen = false;
const FEEDBACK_KEY = "powergrid_feedback";
const FEEDBACK_PENDING_KEY = "powergrid_feedback_pending";
let feedback = [];
let pendingFeedback = [];

try {
    feedback = JSON.parse(localStorage.getItem(FEEDBACK_KEY)) || [];
} catch {
    feedback = [];
}
try {
    pendingFeedback = JSON.parse(localStorage.getItem(FEEDBACK_PENDING_KEY)) || [];
} catch {
    pendingFeedback = [];
}

// Spread markers a little when several outages are in the same barangay.
function placeCoords(barangay) {
    const base = BARANGAYS[barangay] ? BARANGAYS[barangay].coords : [13.7567, 121.0583];
    const n = outages.filter((o) => o.barangay === barangay).length;
    if (n === 0) return base;
    const angle = n * 2.4;
    const radius = 0.0035 + n * 0.0006;
    return [base[0] + Math.sin(angle) * radius, base[1] + Math.cos(angle) * radius];
}

function addOutage({ barangay, address, households, status = "reported", eta, auto = null, cause = "Unknown", since = "Just now", reporter = null, coords, startedAt, notes = "", photo = null, createdAt = new Date().toISOString(), reportCount = 1 }) {
    const outage = {
        id: nextId++,
        barangay,
        address,
        households,
        status,
        eta: eta || ETA_BY_STATUS[status],
        auto,
        cause,
        since,
        reporter,
        notes,
        photo,
        startedAt: startedAt || null,
        createdAt,
        reportCount,
        coords: coords || placeCoords(barangay)
    };
    outage.eta = estimateRestoration(outage);
    outages.push(outage);
    return outage;
}

// Starting sample data (same five reports as before)
addOutage({ barangay: "Poblacion",       address: "P. Burgos Street",    households: 48, status: "verified", eta: "1h 10m", since: "Earlier today" });
addOutage({ barangay: "Kumintang Ibaba", address: "Kumintang Road",      households: 12, status: "reported", eta: "55m",    since: "Earlier today" });
addOutage({ barangay: "Alangilan",       address: "Alangilan Main Road", households: 35, status: "repair",   eta: "2h",     since: "Earlier today" });
addOutage({ barangay: "Bolbok",          address: "Bolbok Crossing",     households: 20, status: "restored", eta: "Restored", since: "Earlier today" });
addOutage({ barangay: "Pallocan West",   address: "Pallocan Road",       households: 7,  status: "reported", eta: "45m",    since: "Earlier today" });

try {
    const saved = JSON.parse(localStorage.getItem("powergrid_live_state"));
    if (saved && Array.isArray(saved.outages) && Array.isArray(saved.feeders)) {
        outages.splice(0, outages.length, ...saved.outages);
        outages.forEach((outage) => {
            outage.createdAt = outage.createdAt || new Date().toISOString();
            outage.reportCount = outage.reportCount || 1;
            outage.notes = outage.notes || "";
            outage.photo = outage.photo || null;
            outage.startedAt = outage.startedAt || null;
            outage.eta = estimateRestoration(outage);
        });
        saved.feeders.forEach((f, i) => {
            if (feeders[i]) Object.assign(feeders[i], f);
        });
        nextId = outages.reduce((max, o) => Math.max(max, Number(o.id) || 0), 0) + 1;
        selectedId = outages.some((o) => o.id === saved.selectedId) ? saved.selectedId : outages[0]?.id || 0;
    }
} catch {
    // Keep the sample state if saved browser data is invalid.
}

/* ---------- small UI helpers ---------- */
function toast(message, type = "info") {
    const wrap = $("#toasts");
    const icons = { info: "✦", success: "✓", danger: "!" };
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || "✦"}</span><span></span>`;
    el.lastElementChild.textContent = message;
    wrap.append(el);
    while (wrap.children.length > 4) wrap.firstElementChild.remove();
    setTimeout(() => {
        el.classList.add("out");
        el.addEventListener("animationend", () => el.remove(), { once: true });
    }, 3400);
    setTimeout(() => el.remove(), 4000); // fallback if animations are turned off
}

function shake(el) {
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    el.addEventListener("animationend", () => el.classList.remove("shake"), { once: true });
}

// Count a number up or down instead of jumping
function tween(el, to) {
    const from = el.dataset.v === undefined ? 0 : Number(el.dataset.v);
    el.dataset.v = to;
    if (from === to) {
        el.textContent = to;
        return;
    }
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
    const start = performance.now();
    const duration = 600;
    (function step(now) {
        const p = Math.min((now - start) / duration, 1);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
    })(start);
}

function log(message, type = "") {
    const list = $("#event-log");
    const li = document.createElement("li");
    li.className = type;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString();
    li.append(time, message);
    list.prepend(li);
    while (list.children.length > 40) list.lastElementChild.remove();
}

/* ---------- sliding highlights (sidebar + map filter tabs) ---------- */
function makeSlider(container) {
    const slider = document.createElement("span");
    slider.className = "slider";
    slider.setAttribute("aria-hidden", "true");
    container.prepend(slider);
    container.classList.add("has-slider");
    return slider;
}
const navSlider = makeSlider($(".nav"));
const tabSlider = makeSlider($(".tabs"));

function moveSlider(slider, target) {
    if (!target || !target.offsetWidth) return; // hidden page: measured again when it shows
    slider.style.width = `${target.offsetWidth}px`;
    slider.style.height = `${target.offsetHeight}px`;
    slider.style.transform = `translate(${target.offsetLeft}px, ${target.offsetTop}px)`;
    if (!slider.classList.contains("ready")) requestAnimationFrame(() => slider.classList.add("ready"));
}

function syncSliders() {
    moveSlider(navSlider, $(".nav-item.active"));
    moveSlider(tabSlider, $(".tab.active"));
}

/* ---------- navigation (old page blurs out, new page blurs in) ---------- */
let pageToken = 0;
const PAGE_EXIT_MS = 220;

// Returns how long (ms) to wait before the new page is on screen.
function showPage(name) {
    if (name !== "map" && pinSelectionActive) {
        pinSelectionActive = false;
        if (map) map.getContainer().style.cursor = "";
        $("#pin-return-report").hidden = true;
    }
    if (name === "admin" && !isStaff) {
        toast("The Admin Board is for PowerGrid staff only", "danger");
        return 0;
    }
    const next = $(`#${name}-page`);
    const current = $(".page.view-active");
    const token = ++pageToken;

    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === name));
    moveSlider(navSlider, $(`.nav-item[data-page="${name}"]`));

    if (current === next) {
        next.classList.remove("leaving");
        return 0;
    }

    const enter = () => {
        if (token !== pageToken) return; // a newer click took over
        $$(".page").forEach((page) => page.classList.remove("view-active", "leaving"));
        next.classList.add("view-active");
        $(".app").scrollTop = 0;
        syncSliders();
        if (name === "map" && map) {
            map.invalidateSize();
            setTimeout(() => map.invalidateSize(), 60);
        }
    };

    if (current) {
        current.classList.add("leaving");
        setTimeout(enter, PAGE_EXIT_MS);
    } else {
        enter();
    }
    return PAGE_EXIT_MS + 40;
}

$$(".nav-item").forEach((item) => item.addEventListener("click", () => showPage(item.dataset.page)));

window.addEventListener("resize", syncSliders);
window.addEventListener("load", syncSliders);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSliders);

// Keyboard shortcuts: 1 Live Map, 2 Report, 3 Network, 4 Admin
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mapFullscreen) {
        setMapFullscreen(false);
        return;
    }
    if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const pages = { "1": "map", "2": "report", "3": "network", "4": "admin" };
    if (pages[e.key]) showPage(pages[e.key]);
});

// Cursor spotlight on glass panels
document.addEventListener("pointermove", (e) => {
    const el = e.target.closest(".spot");
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--my", `${e.clientY - rect.top}px`);
});

/* ---------- map ---------- */
function initMap() {
    if (typeof L === "undefined") {
        $("#leaflet-map").innerHTML = '<div class="map-offline">The map needs an internet connection to load Leaflet and the map tiles.</div>';
        return;
    }

    const batangasCityBounds = L.latLngBounds([13.65, 120.96], [13.84, 121.16]);

    map = L.map("leaflet-map", {
        zoomControl: false,
        attributionControl: true,
        minZoom: 12,
        maxZoom: 18,
        maxBounds: batangasCityBounds,
        maxBoundsViscosity: 1
    }).setView([13.7567, 121.0583], 13);

    L.control.zoom({ position: "bottomleft" }).addTo(map);
    window.outageMap = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        minZoom: 12,
        maxZoom: 18,
        noWrap: true,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    map.on("click", (event) => {
        if (!pinSelectionActive) return;
        report.coords = [event.latlng.lat, event.latlng.lng];
        report.pinSelected = true;
        if (reportPinMarker) reportPinMarker.remove();
        reportPinMarker = L.marker(report.coords).addTo(map).bindTooltip("Report location", { permanent: true, direction: "top" });
        $("#report-pin-status").textContent = `Pinned at ${report.coords[0].toFixed(5)}, ${report.coords[1].toFixed(5)}`;
        pinSelectionActive = false;
        map.getContainer().style.cursor = "";
        $("#pin-return-report").hidden = false;
        toast("Report pin set. Return to the report form to continue.", "success");
    });
}

const markersById = new Map();
let pinSelectionActive = false;
let reportPinMarker = null;
const mapSearch = { text: "", barangay: "", from: "", to: "" };

function setMapFullscreen(expanded) {
    if (expanded === mapFullscreen) return;

    if (expanded) {
        mapPlaceholder = document.createComment("map-position");
        mapArea.parentNode.insertBefore(mapPlaceholder, mapArea);
        document.body.append(mapArea);
        mapArea.classList.add("map-fullscreen");
        document.body.classList.add("map-fullscreen-open");
    } else {
        if (mapPlaceholder && mapPlaceholder.parentNode) {
            mapPlaceholder.parentNode.insertBefore(mapArea, mapPlaceholder);
            mapPlaceholder.remove();
        }
        mapArea.classList.remove("map-fullscreen");
        mapPlaceholder = null;
        document.body.classList.remove("map-fullscreen-open");
    }

    mapFullscreen = expanded;
    const button = $("#map-fullscreen-toggle");
    button.textContent = expanded ? "Exit full view" : "Full view";
    button.setAttribute("aria-label", expanded ? "Exit full map view" : "Show map full view");
    button.setAttribute("aria-pressed", String(expanded));
    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 100);
}

$("#map-fullscreen-toggle").addEventListener("click", () => setMapFullscreen(!mapFullscreen));

function matchesMapFilters(outage) {
    const query = mapSearch.text.toLowerCase();
    if (query && !`${outage.barangay} ${outage.address} ${outage.reporter || ""}`.toLowerCase().includes(query)) return false;
    if (mapSearch.barangay && outage.barangay !== mapSearch.barangay) return false;
    const day = (outage.createdAt || "").slice(0, 10);
    if (mapSearch.from && day < mapSearch.from) return false;
    if (mapSearch.to && day > mapSearch.to) return false;
    return true;
}

function markerIcon(outage, entering = false) {
    const selected = outage.id === selectedId ? " selected" : "";
    const enter = entering ? " enter" : "";
    return L.divIcon({
        className: "",
        html: `<div class="outage-marker ${outage.status}${selected}${enter}">${outage.id}</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
    });
}

// Update markers in place so they don't blink every time something changes
function renderMarkers() {
    if (!map) return;
    const visible = outages.filter((o) => (filter === "all" || o.status === filter) && matchesMapFilters(o));
    const keep = new Set(visible.map((o) => o.id));

    markersById.forEach((marker, id) => {
        if (!keep.has(id)) {
            markerLayer.removeLayer(marker);
            markersById.delete(id);
        }
    });

    visible.forEach((o) => {
        const signature = `${o.status}-${o.id === selectedId}`;
        let marker = markersById.get(o.id);
        if (!marker) {
            marker = L.marker(o.coords, { icon: markerIcon(o, true) }).addTo(markerLayer);
            marker.bindTooltip("", { direction: "top", offset: [0, -18], className: "glass-tip" });
            marker.on("click", () => selectOutage(o.id, { pan: true }));
            marker._signature = signature;
            markersById.set(o.id, marker);
        } else if (marker._signature !== signature) {
            marker.setIcon(markerIcon(o));
            marker._signature = signature;
        }
        marker.setLatLng(o.coords);
        marker.setTooltipContent(`${o.barangay} · ${STATUS_LABEL[o.status]}`);
    });
}

function selectOutage(id, options = {}) {
    selectedId = id;
    renderCard(true);
    renderMarkers();
    const outage = outages.find((o) => o.id === id);
    if (!map || !outage) return;
    if (options.fly) map.flyTo(outage.coords, 15, { duration: 0.9 });
    else if (options.pan) map.panTo(outage.coords, { animate: true });
}

// Open the map page, make sure the outage isn't hidden by a filter, and fly to it
function showOnMap(id) {
    filter = "all";
    const wait = showPage("map");
    renderTabs();
    setTimeout(() => selectOutage(id, { fly: true }), wait + 90);
}

function renderCard(animate = false) {
    const o = outages.find((x) => x.id === selectedId);
    if (!o) return;
    $(".card-kicker").textContent = `SELECTED OUTAGE #${o.id}`;
    $("#card-name").textContent = o.barangay;
    $("#card-address").textContent = o.address;
    $("#card-households").textContent = o.households;
    $("#card-eta").textContent = o.eta;
    $("#card-meta").textContent = `${o.cause} · Started: ${o.startedAt ? new Date(o.startedAt).toLocaleString() : o.since} · ${o.reportCount || 1} similar report${(o.reportCount || 1) === 1 ? "" : "s"}` + (o.reporter ? ` · Reported by ${o.reporter}` : "");
    $("#card-photo").src = o.photo || "";
    $("#card-photo").hidden = !o.photo;
    const badge = $("#card-status");
    badge.textContent = STATUS_LABEL[o.status];
    badge.className = `status-badge ${o.status}`;
    if (animate) {
        const card = $("#outage-card");
        card.classList.remove("swap");
        void card.offsetWidth;
        card.classList.add("swap");
    }
}

function renderTabs() {
    const labels = { all: "All", reported: "Reported", verified: "Verified", repair: "Under Repair", restored: "Restored" };
    $$(".tab").forEach((tab) => {
        const f = tab.dataset.filter;
        const count = f === "all" ? outages.length : outages.filter((o) => o.status === f).length;
        tab.textContent = `${labels[f]} (${count})`;
        tab.classList.toggle("active", f === filter);
    });
    moveSlider(tabSlider, $(".tab.active"));
}

function renderAreaStatus() {
    const grid = $("#area-status-grid");
    if (!grid) return;

    let brownoutCount = 0;
    grid.innerHTML = Object.keys(BARANGAYS).map((name) => {
        const hasActiveOutage = outages.some((o) => o.barangay === name && o.status !== "restored");
        const feederOnline = feeders[BARANGAYS[name].feeder].online;
        const isBrownout = hasActiveOutage || !feederOnline;
        if (isBrownout) brownoutCount++;
        const active = outages.find((o) => o.barangay === name && o.status !== "restored");
        const statusText = isBrownout
            ? active ? `${STATUS_LABEL[active.status]} · ${active.address}` : "No power · feeder down"
            : "Power is available";
        return `
            <button class="area-status-button ${isBrownout ? "brownout" : ""}" type="button" data-area="${esc(name)}">
                <span><strong>${esc(name)}</strong><small>${esc(statusText)}</small></span>
                <i class="area-status-indicator" aria-hidden="true"></i>
            </button>`;
    }).join("");

    const summary = $("#area-status-summary");
    summary.textContent = brownoutCount
        ? `${brownoutCount} ${brownoutCount === 1 ? "area" : "areas"} brownout`
        : "No brownouts reported";
    summary.classList.toggle("has-brownout", brownoutCount > 0);

    $$(".area-status-button").forEach((button) => {
        button.addEventListener("click", () => {
            const name = button.dataset.area;
            const active = outages.find((o) => o.barangay === name && o.status !== "restored");
            if (active) showOnMap(active.id);
            else {
                showPage("map");
                setTimeout(() => map && map.flyTo(BARANGAYS[name].coords, 15, { duration: 0.9 }), 260);
                toast(`${name} has no active brownout report`, "success");
            }
        });
    });
}

$$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
        filter = tab.dataset.filter;
        renderTabs();
        renderMarkers();
    })
);

$("#map-search").addEventListener("input", (e) => {
    mapSearch.text = e.target.value.trim();
    renderMarkers();
});
$("#map-barangay-filter").addEventListener("change", (e) => {
    mapSearch.barangay = e.target.value;
    renderMarkers();
});
$("#map-date-from").addEventListener("change", (e) => {
    mapSearch.from = e.target.dataset.dateValue || "";
    renderMarkers();
});
$("#map-date-to").addEventListener("change", (e) => {
    mapSearch.to = e.target.dataset.dateValue || "";
    renderMarkers();
});
$("#clear-map-filters").addEventListener("click", () => {
    mapSearch.text = "";
    mapSearch.barangay = "";
    mapSearch.from = "";
    mapSearch.to = "";
    $("#map-search").value = "";
    $("#map-barangay-filter").value = "";
    $("#map-date-from").value = "";
    $("#map-date-to").value = "";
    $("#map-date-from").dataset.dateValue = "";
    $("#map-date-to").dataset.dateValue = "";
    filter = "all";
    renderTabs();
    renderMarkers();
});

const datePicker = $("#date-picker");
let calendarTarget = null;
let calendarMonth = new Date();

function renderCalendar() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const monthName = calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const offset = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const selected = calendarTarget && calendarTarget.dataset.dateValue;
    const cells = Array.from({ length: offset }, () => '<span class="calendar-blank"></span>');
    for (let day = 1; day <= days; day++) {
        const date = new Date(year, month, day);
        const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        cells.push(`<button type="button" class="calendar-day${iso === selected ? " selected" : ""}" data-calendar-date="${iso}">${day}</button>`);
    }

    datePicker.innerHTML = `
        <div class="calendar-header">
            <button type="button" class="back-button" data-calendar-month="-1" aria-label="Previous month">‹</button>
            <strong>${esc(monthName)}</strong>
            <button type="button" class="back-button" data-calendar-month="1" aria-label="Next month">›</button>
        </div>
        <div class="calendar-grid calendar-weekdays">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="calendar-grid">${cells.join("")}</div>
        <button type="button" class="calendar-today" data-calendar-date="${new Date().toISOString().slice(0, 10)}">Today</button>`;
}

function openCalendar(input) {
    calendarTarget = input;
    const selected = input.dataset.dateValue;
    calendarMonth = selected ? new Date(`${selected}T12:00:00`) : new Date();
    calendarMonth.setDate(1);
    renderCalendar();
    datePicker.hidden = false;
    const rect = input.getBoundingClientRect();
    const width = 270;
    datePicker.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 320)}px`;
    datePicker.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
}

$$("[data-calendar-target]").forEach((button) => {
    button.addEventListener("click", () => openCalendar($(`#${button.dataset.calendarTarget}`)));
});
["map-date-from", "map-date-to"].forEach((id) => {
    $(`#${id}`).addEventListener("click", (e) => openCalendar(e.currentTarget));
});
datePicker.addEventListener("click", (e) => {
    const monthButton = e.target.closest("[data-calendar-month]");
    if (monthButton) {
        calendarMonth.setMonth(calendarMonth.getMonth() + Number(monthButton.dataset.calendarMonth));
        calendarMonth.setDate(1);
        renderCalendar();
        return;
    }
    const dayButton = e.target.closest("[data-calendar-date]");
    if (!dayButton || !calendarTarget) return;
    const iso = dayButton.dataset.calendarDate;
    calendarTarget.dataset.dateValue = iso;
    calendarTarget.value = new Date(`${iso}T12:00:00`).toLocaleDateString();
    calendarTarget.dispatchEvent(new Event("change", { bubbles: true }));
    datePicker.hidden = true;
});
document.addEventListener("click", (e) => {
    if (!e.target.closest(".date-picker, .calendar-trigger, #map-date-from, #map-date-to")) datePicker.hidden = true;
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") datePicker.hidden = true;
});

$("#manage-button").addEventListener("click", () => {
    const wait = showPage("admin");
    setTimeout(() => flashCard(selectedId), wait + 60);
});

function renderStats() {
    const active = outages.filter((o) => o.status !== "restored");
    tween($("#stat-active"), active.length);
    tween($("#stat-households"), active.reduce((sum, o) => sum + o.households, 0));
    tween($("#stat-restored"), outages.filter((o) => o.status === "restored").length);
    const online = feeders.filter((f) => f.online).length;
    $("#stat-feeders").innerHTML = `${online} <small>of ${feeders.length}</small>`;
}

/* ---------- history and demo forecast ---------- */
function renderForecast() {
    const markup = Object.keys(BARANGAYS).map((name) => {
        const risk = outageRisk(name);
        const active = outages.find((o) => o.barangay === name && o.status !== "restored");
        const level = risk >= 60 ? "high" : risk >= 35 ? "medium" : "low";
        const recovery = active ? estimateRestoration(active) : "No active outage";
        return `<button class="risk ${level}" type="button" data-barangay="${esc(name)}" data-risk="${risk}">
            <strong>${esc(name)}</strong>
            <span>${level} · ${risk}%</span>
            <small>Restore: ${esc(recovery)}</small>
            <i class="bar"><b style="width:${risk}%"></b></i>
        </button>`;
    }).join("");
    $("#forecast-grid").innerHTML = markup;
    $("#admin-forecast-grid").innerHTML = markup;
}

function renderHistory() {
    const month = $("#history-month").value || new Date().toISOString().slice(0, 7);
    const monthly = outages.filter((o) => (o.createdAt || "").slice(0, 7) === month);
    const active = monthly.filter((o) => o.status !== "restored").length;
    const restored = monthly.filter((o) => o.status === "restored").length;
    const totals = new Map();
    monthly.forEach((o) => totals.set(o.barangay, (totals.get(o.barangay) || 0) + 1));
    $("#history-summary").innerHTML = `
        <span>${monthly.length} reports in ${esc(month)}</span>
        <span>${active} active</span>
        <span>${restored} restored</span>
        <span>${[...totals.entries()].map(([name, count]) => `${esc(name)}: ${count}`).join(" · ") || "No reports"}</span>`;
    const all = [...outages].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    $("#history-list").innerHTML = all.length ? all.map((o) => `
        <article class="history-item">
            <span class="status-badge ${esc(o.status)}">${esc(STATUS_LABEL[o.status])}</span>
            <strong>#${o.id} · ${esc(o.barangay)} · ${esc(o.address)}</strong>
            <span>${esc(new Date(o.createdAt).toLocaleDateString())} · ${o.households} households · ${o.reportCount || 1} similar reports</span>
        </article>`).join("") : '<p class="feedback-empty">No outage history yet.</p>';
}

$("#history-month").value = new Date().toISOString().slice(0, 7);
$("#history-month").addEventListener("change", renderHistory);

function locateForecastArea(name) {
    const active = outages.find((o) => o.barangay === name && o.status !== "restored");
    toast(`${name}: ${outageRisk(name)}% demo risk estimate`, "info");
    if (active) showOnMap(active.id);
    else {
        showPage("map");
        setTimeout(() => map && map.flyTo(BARANGAYS[name].coords, 15, { duration: 0.9 }), 260);
    }
}

$("#forecast-grid").addEventListener("click", (e) => {
    const button = e.target.closest("[data-barangay]");
    if (button) locateForecastArea(button.dataset.barangay);
});
$("#admin-forecast-grid").addEventListener("click", (e) => {
    const button = e.target.closest("[data-barangay]");
    if (button) locateForecastArea(button.dataset.barangay);
});

/* ---------- admin board ---------- */
function cardHTML(o) {
    const index = STATUS_ORDER.indexOf(o.status);
    const forward = [
        ["verify-button", "Verify"],
        ["start-button", "Start repair"],
        ["restore-button", "Mark restored"]
    ][index];
    const backBtn = index > 0 ? '<button class="back-button" type="button" data-action="back">Back</button>' : "";
    const fwdBtn = forward ? `<button class="${forward[0]}" type="button" data-action="forward">${forward[1]}</button>` : "";
    const auto = o.auto !== null ? ' <span class="tag">auto-detected</span>' : "";
    return `
        <article class="report-card spot ${o.status}" data-id="${o.id}">
            <h4>#${o.id} · ${esc(o.barangay)}</h4>
            <p>${esc(o.address)}<br>${o.households} households · ${o.reportCount || 1} similar reports${auto}${o.reporter ? `<br>Reported by ${esc(o.reporter)}` : ""}<br>ETA ${esc(estimateRestoration(o))}</p>
            ${o.notes ? `<p>${esc(o.notes)}</p>` : ""}
            ${o.photo ? `<img class="report-card-photo" src="${o.photo}" alt="Resident outage report">` : ""}
            <div class="actions">${backBtn}${fwdBtn}<button class="back-button" type="button" data-action="edit">Edit</button><button class="back-button" type="button" data-action="delete">Delete</button></div>
        </article>`;
}

// Cards slide to their new spot (FLIP); a card that changed column blurs in
function renderAdmin() {
    const animate = $("#admin-page").classList.contains("view-active");
    const before = new Map();
    if (animate) {
        $$(".report-card").forEach((card) =>
            before.set(card.dataset.id, { rect: card.getBoundingClientRect(), column: card.closest(".admin-column").dataset.status })
        );
    }

    $$(".admin-column").forEach((column) => {
        const list = outages.filter((o) => o.status === column.dataset.status);
        $(".count", column).textContent = list.length;
        $(".cards", column).innerHTML = list.length ? list.map(cardHTML).join("") : '<p class="empty">Nothing here yet</p>';
    });

    if (animate) {
        $$(".report-card").forEach((card) => {
            const old = before.get(card.dataset.id);
            const column = card.closest(".admin-column").dataset.status;
            if (!old || old.column !== column) {
                if (before.size) {
                    card.animate(
                        [
                            { opacity: 0, transform: "scale(0.92)", filter: "blur(8px)" },
                            { opacity: 1, transform: "none", filter: "blur(0)" }
                        ],
                        { duration: 450, easing: EASE }
                    );
                }
                return;
            }
            const now = card.getBoundingClientRect();
            const dx = old.rect.left - now.left;
            const dy = old.rect.top - now.top;
            if (dx || dy) card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 450, easing: EASE });
        });
    }
    lastChangedId = null;
}

function flashCard(id) {
    const card = $(`.report-card[data-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
}

function moveOutage(outage, direction) {
    const next = STATUS_ORDER[STATUS_ORDER.indexOf(outage.status) + direction];
    if (!next) return;
    outage.status = next;
    outage.eta = estimateRestoration(outage);
    lastChangedId = outage.id;
    renderAll();
    toast(`#${outage.id} ${outage.barangay} → ${STATUS_LABEL[next]}`, next === "restored" ? "success" : "info");
}

$(".admin-columns").addEventListener("click", (e) => {
    const card = e.target.closest(".report-card");
    if (!card) return;
    const outage = outages.find((o) => o.id === Number(card.dataset.id));
    if (!outage) return;
    const button = e.target.closest("[data-action]");
    if (button) {
        const action = button.dataset.action;
        if (action === "forward") moveOutage(outage, 1);
        else if (action === "back") moveOutage(outage, -1);
        else if (action === "edit") {
            const address = prompt("Street or landmark:", outage.address);
            if (address === null) return;
            const households = Number(prompt("Estimated households affected:", String(outage.households)));
            if (!address.trim() || !Number.isInteger(households) || households < 1 || households > 5000) {
                toast("Keep a location and enter 1–5000 households", "danger");
                return;
            }
            outage.address = address.trim();
            outage.households = households;
            outage.eta = estimateRestoration(outage);
            renderAll();
            toast(`Report #${outage.id} updated`, "success");
        } else if (action === "delete" && confirm(`Delete report #${outage.id}?`)) {
            outages.splice(outages.indexOf(outage), 1);
            selectedId = outages[0] ? outages[0].id : 0;
            renderAll();
            toast("Report deleted", "info");
        }
    } else if (e.target.closest("h4")) {
        showOnMap(outage.id);
    }
});

const ANNOUNCEMENTS_KEY = "powergrid_announcements";
let announcements = [];
try {
    announcements = JSON.parse(localStorage.getItem(ANNOUNCEMENTS_KEY)) || [];
} catch {
    announcements = [];
}
if (!announcements.length) {
    announcements = [{ id: Date.now(), text: "Sample scheduled maintenance in Alangilan, Saturday 8 AM to 12 PM.", createdAt: new Date().toISOString() }];
}

function renderAnnouncements() {
    const newest = announcements[0];
    $$(".announcement p").forEach((p) => {
        const label = document.createElement("strong");
        const typeLabels = { maintenance: "Maintenance:", weather: "Weather advisory:", general: "Update:" };
        label.textContent = newest ? typeLabels[newest.type] || "Announcement:" : "Announcement:";
        p.replaceChildren(label, ` ${newest ? newest.text : "No current advisories."}`);
    });
    const list = $("#announcement-list");
    list.innerHTML = announcements.map((item) => `
        <article class="announcement-item">
            <span><strong>${esc(item.type || "general")}</strong> · ${esc(item.text)}<small>${esc(new Date(item.createdAt).toLocaleString())}</small></span>
            <button type="button" class="back-button" data-announcement-edit="${item.id}">Edit</button>
            <button type="button" class="back-button" data-announcement-delete="${item.id}">Delete</button>
        </article>`).join("") || '<p class="feedback-empty">No announcements.</p>';
}

function saveAnnouncements() {
    localStorage.setItem(ANNOUNCEMENTS_KEY, JSON.stringify(announcements));
    renderAnnouncements();
}

$("#announcement-list").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-announcement-edit]");
    const remove = e.target.closest("[data-announcement-delete]");
    if (edit) {
        const item = announcements.find((a) => a.id === Number(edit.dataset.announcementEdit));
        if (!item) return;
        const text = prompt("Edit announcement:", item.text);
        if (text === null || !text.trim()) return;
        item.text = text.trim();
        saveAnnouncements();
    } else if (remove) {
        announcements = announcements.filter((a) => a.id !== Number(remove.dataset.announcementDelete));
        saveAnnouncements();
    }
});

function postAnnouncement() {
    const input = $("#announcement-text");
    const text = input.value.trim();
    if (!text) {
        shake(input);
        toast("Type an announcement first", "danger");
        return;
    }
    announcements.unshift({ id: Date.now(), type: $("#announcement-type").value, text, createdAt: new Date().toISOString() });
    saveAnnouncements();
    $$(".announcement").forEach((banner) => {
        banner.classList.remove("ping");
        void banner.offsetWidth;
        banner.classList.add("ping");
    });
    input.value = "";
    toast("Announcement posted on every page", "success");
}

renderAnnouncements();
$("#post-announcement").addEventListener("click", postAnnouncement);
$("#announcement-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") postAnnouncement();
});

function renderAreaAdmin() {
    $("#area-admin-list").innerHTML = Object.entries(BARANGAYS).map(([name, area]) => `
        <div class="admin-list-row">
            <span><strong>${esc(name)}</strong><small>Feeder ${area.feeder + 1} · ${area.coords.map((n) => Number(n).toFixed(4)).join(", ")}</small></span>
            <button type="button" class="back-button" data-area-edit="${esc(name)}">Edit</button>
            <button type="button" class="back-button" data-area-delete="${esc(name)}">Remove</button>
        </div>`).join("");
}

function saveAreas() {
    localStorage.setItem("powergrid_areas", JSON.stringify(Object.entries(BARANGAYS).map(([name, area]) => ({
        name, coords: area.coords, feeder: area.feeder
    }))));
}

$("#area-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#area-name").value.trim();
    const lat = Number($("#area-lat").value);
    const lng = Number($("#area-lng").value);
    if (!name || BARANGAYS[name] || Object.keys(BARANGAYS).some((area) => area.toLowerCase() === name.toLowerCase())) {
        toast("Enter a new, unique barangay name", "danger");
        return;
    }
    const hasLat = Boolean($("#area-lat").value);
    const hasLng = Boolean($("#area-lng").value);
    if (hasLat !== hasLng) {
        toast("Enter both latitude and longitude, or leave both blank", "danger");
        return;
    }
    const coords = hasLat ? [lat, lng] : [13.7567, 121.0583];
    if (!coords.every(Number.isFinite) || (hasLat && (lat < 13.65 || lat > 13.84 || lng < 120.96 || lng > 121.16))) {
        toast("Use coordinates inside Batangas City", "danger");
        return;
    }
    BARANGAYS[name] = { coords, feeder: Number($("#area-feeder").value) };
    saveAreas();
    $("#area-form").reset();
    renderBarangayOptions();
    renderAreaAdmin();
    renderAll();
    toast(`${name} added`, "success");
});

$("#area-admin-list").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-area-edit]");
    const button = e.target.closest("[data-area-delete]");
    if (edit) {
        const area = BARANGAYS[edit.dataset.areaEdit];
        if (!area) return;
        const latText = prompt("Latitude:", String(area.coords[0]));
        if (latText === null) return;
        const lngText = prompt("Longitude:", String(area.coords[1]));
        if (lngText === null) return;
        const feederText = prompt("Feeder number (1–3):", String(area.feeder + 1));
        if (feederText === null) return;
        const lat = Number(latText);
        const lng = Number(lngText);
        const feederNumber = Number(feederText);
        if (!Number.isFinite(lat) || lat < 13.65 || lat > 13.84 || !Number.isFinite(lng) || lng < 120.96 || lng > 121.16 ||
            !Number.isInteger(feederNumber) || feederNumber < 1 || feederNumber > 3) {
            toast("Use valid Batangas City coordinates and feeder 1–3", "danger");
            return;
        }
        area.coords = [lat, lng];
        area.feeder = feederNumber - 1;
        saveAreas();
        renderAreaAdmin();
        renderAll();
        toast(`${edit.dataset.areaEdit} updated`, "success");
        return;
    }
    if (!button) return;
    const name = button.dataset.areaDelete;
    if (outages.some((o) => o.barangay === name)) {
        toast("This area has outage history and cannot be removed", "danger");
        return;
    }
    if (Object.keys(BARANGAYS).length <= 1) {
        toast("At least one barangay must remain", "danger");
        return;
    }
    if (!confirm(`Remove ${name} from the demo area list?`)) return;
    delete BARANGAYS[name];
    saveAreas();
    renderBarangayOptions();
    renderAreaAdmin();
    renderAll();
    toast(`${name} removed`, "info");
});

function renderUserAdmin() {
    let users = [];
    try {
        users = JSON.parse(localStorage.getItem("powergrid_users")) || [];
    } catch {
        users = [];
    }
    const allUsers = [Auth.DEMO_ADMIN, ...users];
    $("#user-admin-list").innerHTML = allUsers.map((account) => `
        <div class="admin-list-row">
            <span><strong>${esc(account.name)}</strong><small>${esc(account.email)} · ${account.role === "admin" ? "Staff" : "Resident"}</small></span>
            ${account.email === Auth.DEMO_ADMIN.email ? '<small>Demo admin</small>' :
                `<button type="button" class="back-button" data-user-edit="${esc(account.email)}">Edit</button>
                <button type="button" class="back-button" data-user-role="${esc(account.email)}">${account.role === "admin" ? "Make resident" : "Make staff"}</button>
                <button type="button" class="back-button" data-user-delete="${esc(account.email)}">Delete</button>`}
        </div>`).join("") || '<p class="feedback-empty">No registered users.</p>';
}

$("#user-admin-list").addEventListener("click", (e) => {
    const editButton = e.target.closest("[data-user-edit]");
    const roleButton = e.target.closest("[data-user-role]");
    const deleteButton = e.target.closest("[data-user-delete]");
    let users;
    try {
        users = JSON.parse(localStorage.getItem("powergrid_users")) || [];
    } catch {
        users = [];
    }
    const email = editButton ? editButton.dataset.userEdit : roleButton ? roleButton.dataset.userRole : deleteButton && deleteButton.dataset.userDelete;
    const account = users.find((item) => item.email === email);
    if (!account) return;
    if (email === user.email) {
        toast("You cannot edit or remove your own account", "danger");
        return;
    }
    if (editButton) {
        const name = prompt("User name:", account.name);
        if (name === null) return;
        const nextEmail = prompt("Email:", account.email);
        if (nextEmail === null) return;
        const normalizedEmail = nextEmail.trim().toLowerCase();
        if (!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
            users.some((item) => item !== account && item.email.toLowerCase() === normalizedEmail)) {
            toast("Enter a name and a unique valid email", "danger");
            return;
        }
        account.name = name.trim();
        account.email = normalizedEmail;
    } else if (roleButton) {
        account.role = account.role === "admin" ? "resident" : "admin";
    } else if (deleteButton) {
        if (email === user.email || !confirm(`Delete account ${email}?`)) return;
        users = users.filter((item) => item.email !== email);
    }
    localStorage.setItem("powergrid_users", JSON.stringify(users));
    renderUserAdmin();
});

/* ---------- report wizard ---------- */
const defaultBarangay = BARANGAYS[user.barangay] ? user.barangay : Object.keys(BARANGAYS)[0];
const report = {
    step: 1,
    barangay: defaultBarangay,
    landmark: "",
    when: "Just now",
    households: 10,
    cause: "Unknown",
    notes: "",
    coords: [...BARANGAYS[defaultBarangay].coords],
    pinSelected: false,
    startedAt: "",
    photo: null,
    photoLoading: false
};

function renderBarangayOptions() {
    if (!BARANGAYS[report.barangay]) {
        report.barangay = defaultBarangay;
        report.coords = [...BARANGAYS[defaultBarangay].coords];
    }
    const names = Object.keys(BARANGAYS);
    $("#report-barangay-options").innerHTML = names.map((name) =>
        `<button class="barangay${name === report.barangay ? " active" : ""}" type="button" data-barangay="${esc(name)}">${esc(name)}</button>`
    ).join("");

    const filterSelect = $("#map-barangay-filter");
    const currentFilter = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All barangays</option>' +
        names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    filterSelect.value = names.includes(currentFilter) ? currentFilter : "";

    const feedbackSelect = $("#feedback-barangay");
    if (feedbackSelect) {
        const selected = names.includes(feedbackSelect.value) ? feedbackSelect.value : report.barangay;
        feedbackSelect.innerHTML = names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
        feedbackSelect.value = selected;
    }
}

renderBarangayOptions();

function clampHouseholds(value) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? 1 : Math.min(500, Math.max(1, n));
}

function validateStepOne() {
    if (report.landmark.trim()) return true;
    const input = $("#landmark");
    shake(input);
    input.focus();
    toast("Add a street or landmark so crews can find the outage", "danger");
    return false;
}

let stepToken = 0;

// Old step fades out in the direction you're leaving, new one fades in from the other side
function setStep(n, instant = false) {
    const previous = report.step;
    report.step = n;
    $$(".step").forEach((step, i) => {
        step.classList.toggle("active", i + 1 === n);
        step.classList.toggle("done", i + 1 < n);
    });
    $("#report-back").hidden = n === 1;
    $("#report-next").textContent = n === 3 ? "Submit report" : "Next step";
    if (n === 3) {
        $("#report-summary").innerHTML =
            `<strong>Summary:</strong> ${esc(report.barangay)}, ${esc(report.landmark.trim())} · started ${esc(report.when.toLowerCase())}`;
    }

    const panels = $$(".step-panel");
    const next = panels.find((p) => Number(p.dataset.step) === n);
    const current = panels.find((p) => p.classList.contains("active"));
    const direction = n >= previous ? "fwd" : "back";
    const token = ++stepToken;
    const show = () => {
        if (token !== stepToken) return;
        panels.forEach((p) => p.classList.remove("active", "leaving", "fwd", "back"));
        next.classList.add("active", direction);
    };
    if (instant || !current || current === next) {
        show();
    } else {
        current.classList.add("leaving", direction);
        setTimeout(show, 180);
    }
}

function goToStep(target) {
    if (target > 1 && !validateStepOne()) return;
    setStep(target);
}

function submitReport() {
    if (report.photoLoading) {
        toast("Wait for the selected photo to finish processing", "info");
        return;
    }
    const normalizedAddress = report.landmark.trim().toLowerCase().replace(/\s+/g, " ");
    const duplicate = outages.find((o) => {
        if (o.barangay !== report.barangay || o.status === "restored") return false;
        const sameAddress = o.address.trim().toLowerCase().replace(/\s+/g, " ") === normalizedAddress;
        const distance = report.pinSelected && map ? map.distance(o.coords, report.coords) : Infinity;
        return sameAddress || distance <= 150;
    });

    if (duplicate) {
        duplicate.households += clampHouseholds($("#households").value);
        duplicate.reportCount = (duplicate.reportCount || 1) + 1;
        duplicate.notes = [duplicate.notes, report.notes.trim()].filter(Boolean).join(" · ");
        if (report.photo) duplicate.photo = report.photo;
        duplicate.eta = estimateRestoration(duplicate);
        toast(`Added to outage #${duplicate.id}; ${duplicate.reportCount} similar reports grouped`, "success");
        resetReport();
        renderAll();
        showOnMap(duplicate.id);
        return;
    }

    const outage = addOutage({
        barangay: report.barangay,
        address: report.landmark.trim(),
        households: clampHouseholds($("#households").value),
        cause: report.cause,
        since: report.when,
        startedAt: report.startedAt || null,
        coords: [...report.coords],
        notes: report.notes.trim(),
        photo: report.photo,
        reporter: user.name
    });
    toast(`Report #${outage.id} saved for ${outage.barangay}`, "success");
    resetReport();
    renderAll();
    showOnMap(outage.id);
}

function markDefaultBarangay() {
    $$(".barangay").forEach((b) => b.classList.toggle("active", b.dataset.barangay === report.barangay));
}

function resetReport() {
    pinSelectionActive = false;
    if (map) map.getContainer().style.cursor = "";
    $("#pin-return-report").hidden = true;
    Object.assign(report, {
        barangay: defaultBarangay,
        landmark: "",
        when: "Just now",
        households: 10,
        cause: "Unknown",
        notes: "",
        coords: [...BARANGAYS[defaultBarangay].coords],
        pinSelected: false,
        startedAt: "",
        photo: null,
        photoLoading: false
    });
    $("#landmark").value = "";
    $("#households").value = 10;
    $("#notes").value = "";
    $("#outage-started-at").value = "";
    $("#report-photo").value = "";
    $("#report-photo-name").textContent = "No photo selected · JPG or PNG, up to 8 MB";
    $("#report-photo-preview").replaceChildren();
    $("#report-pin-status").textContent = "No exact pin selected; the area center will be used.";
    if (reportPinMarker) {
        reportPinMarker.remove();
        reportPinMarker = null;
    }
    markDefaultBarangay();
    $$(".chip-row").forEach((row) => $$(".chip", row).forEach((c, i) => c.classList.toggle("active", i === 0)));
    setStep(1, true);
}

$$(".step").forEach((step) => step.addEventListener("click", () => goToStep(Number(step.dataset.go))));

$("#report-barangay-options").addEventListener("click", (e) => {
    const button = e.target.closest(".barangay");
    if (button) {
        $$(".barangay").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        report.barangay = button.dataset.barangay;
        report.coords = [...BARANGAYS[report.barangay].coords];
        report.pinSelected = false;
        if (reportPinMarker) {
            reportPinMarker.remove();
            reportPinMarker = null;
        }
        $("#report-pin-status").textContent = "No exact pin selected; the area center will be used.";
        if (map) map.flyTo(report.coords, 14, { duration: 0.6 });
    }
});

$("#landmark").addEventListener("input", (e) => {
    report.landmark = e.target.value;
});
$("#landmark").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#report-next").click();
});
$("#outage-started-at").addEventListener("change", (e) => {
    report.startedAt = e.target.value;
});

$("#pick-report-pin").addEventListener("click", () => {
    if (!map) {
        toast("The map is unavailable; choose a barangay and landmark instead", "danger");
        return;
    }
    pinSelectionActive = true;
    $("#report-pin-status").textContent = "Click the map to place the exact outage location.";
    if (reportPinMarker) {
        reportPinMarker.remove();
        reportPinMarker = null;
    }
    map.getContainer().style.cursor = "crosshair";
    $("#pin-return-report").hidden = false;
    showPage("map");
    setTimeout(() => {
        map.invalidateSize();
        map.flyTo(BARANGAYS[report.barangay].coords, 15, { duration: 0.6 });
        toast("Click the map to place the outage pin", "info");
    }, 260);
});
$("#pin-return-report").addEventListener("click", () => {
    pinSelectionActive = false;
    if (map) map.getContainer().style.cursor = "";
    $("#pin-return-report").hidden = true;
    showPage("report");
});

$("#report-photo").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
        e.target.value = "";
        $("#report-photo-name").textContent = "No photo selected · JPG or PNG, up to 8 MB";
        toast("Choose an image smaller than 8 MB", "danger");
        return;
    }
    $("#report-photo-name").textContent = file.name;
    report.photoLoading = true;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
        const image = new Image();
        image.addEventListener("load", () => {
            const scale = Math.min(1, 900 / Math.max(image.width, image.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            const context = canvas.getContext("2d");
            if (!context) {
                report.photoLoading = false;
                toast("Could not process this photo", "danger");
                return;
            }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            report.photo = canvas.toDataURL("image/jpeg", 0.65);
            const preview = new Image();
            preview.src = report.photo;
            preview.alt = "Selected outage photo";
            $("#report-photo-preview").replaceChildren(preview);
            report.photoLoading = false;
        });
        image.addEventListener("error", () => {
            report.photoLoading = false;
            toast("Could not read this photo", "danger");
        });
        image.src = reader.result;
    });
    reader.addEventListener("error", () => {
        report.photoLoading = false;
        toast("Could not read this photo", "danger");
    });
    reader.readAsDataURL(file);
});

$$(".chip-row").forEach((row) =>
    row.addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        $$(".chip", row).forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        report[row.dataset.group] = chip.textContent.trim();
    })
);

$("#hh-minus").addEventListener("click", () => {
    $("#households").value = clampHouseholds(clampHouseholds($("#households").value) - 1);
});
$("#hh-plus").addEventListener("click", () => {
    $("#households").value = clampHouseholds(clampHouseholds($("#households").value) + 1);
});
$("#households").addEventListener("change", (e) => {
    e.target.value = clampHouseholds(e.target.value);
});
$("#notes").addEventListener("input", (e) => {
    report.notes = e.target.value;
});

$("#report-back").addEventListener("click", () => setStep(report.step - 1));
$("#report-next").addEventListener("click", () => {
    if (report.step === 1 && !validateStepOne()) return;
    if (report.step < 3) setStep(report.step + 1);
    else submitReport();
});

/* ---------- community feedback ---------- */
function renderFeedback() {
    const list = $("#feedback-list");
    if (!list) return;
    if (!feedback.length) {
        list.innerHTML = '<p class="feedback-empty">No whereabouts reports yet.</p>';
        return;
    }

    list.innerHTML = feedback.slice(0, 20).map((item) => `
        <article class="feedback-item">
            <div class="feedback-item-header">
                <strong>${esc(item.barangay)} · ${esc(item.location)}</strong>
                <time>${esc(item.time)}</time>
            </div>
            <p>${esc(item.comment)}</p>
        </article>
    `).join("");
}

renderBarangayOptions();
$("#feedback-barangay").value = defaultBarangay;

$("#feedback-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const barangay = $("#feedback-barangay").value;
    const location = $("#feedback-location").value.trim();
    const comment = $("#feedback-comment").value.trim();

    if (!location || !comment) {
        if (!location) shake($("#feedback-location"));
        if (!comment) shake($("#feedback-comment"));
        toast("Add a street or landmark and a comment", "danger");
        return;
    }

    feedback.unshift({
        barangay,
        location,
        comment,
        time: new Date().toLocaleString(),
        author: user.name
    });
    pendingFeedback.unshift(feedback[0]);
    try {
        localStorage.setItem(FEEDBACK_KEY, JSON.stringify(feedback));
        localStorage.setItem(FEEDBACK_PENDING_KEY, JSON.stringify(pendingFeedback));
    } catch {
        toast("Feedback could not be saved in this browser", "danger");
        return;
    }

    $("#feedback-location").value = "";
    $("#feedback-comment").value = "";
    renderFeedback();
    updateSmsLink();
    toast(navigator.onLine ? `Feedback saved for ${barangay}` : `Feedback saved offline for ${barangay}`, navigator.onLine ? "success" : "info");
});

$("#feedback-clear").addEventListener("click", () => {
    if (!feedback.length) return;
    feedback = [];
    pendingFeedback = [];
    localStorage.removeItem(FEEDBACK_KEY);
    localStorage.removeItem(FEEDBACK_PENDING_KEY);
    renderFeedback();
    toast("All community feedback cleared", "info");
});

function updateSmsLink() {
    const link = $("#sms-feedback");
    if (!link) return;
    const barangay = $("#feedback-barangay").value;
    const location = $("#feedback-location").value.trim();
    const message = `PowerGrid brownout report - ${barangay}${location ? ` - ${location}` : ""}`;
    link.href = `sms:?&body=${encodeURIComponent(message)}`;
}

$("#feedback-barangay").addEventListener("change", updateSmsLink);
$("#feedback-location").addEventListener("input", updateSmsLink);
updateSmsLink();

/* ---------- network simulation ---------- */
function renderNetwork() {
    $$(".feeder").forEach((el, i) => {
        const f = feeders[i];
        el.classList.toggle("offline", !f.online);
        $(".feeder-state span", el).textContent = f.online ? "ONLINE" : "OFFLINE";
        $(".feeder-stats", el).textContent = f.online ? `Latency ${f.latency} ms · Loss ${f.loss}%` : "Latency — · Loss 100%";
        const button = $(".cut-button", el);
        button.textContent = f.online ? "Cut link (simulate fault)" : "Restore link";
        button.classList.toggle("restore", !f.online);
    });

    $$(".net-col").forEach((col, i) => {
        col.classList.toggle("down", !feeders[i].online);
        const areas = Object.entries(BARANGAYS).filter(([, area]) => area.feeder === i);
        col.innerHTML = `<span class="net-label">${feeders[i].online ? `Powered by Feeder ${i + 1}` : `Feeder ${i + 1} is down`}</span>` +
            areas.map(([name]) => {
                const hasActive = outages.some((o) => o.barangay === name && o.status !== "restored");
                const powered = feeders[i].online && !hasActive;
                return `<button class="net-brgy${powered ? "" : " dark"}" type="button" data-barangay="${esc(name)}">
                    <span>${esc(name)}</span><small>${powered ? "Powered" : "Brownout"}</small></button>`;
            }).join("");
    });
    $$(".network-connectors i").forEach((drop, i) => drop.classList.toggle("down", !feeders[i].online));

    const online = feeders.filter((f) => f.online).length;
    const substation = $(".substation");
    substation.textContent = online === feeders.length ? "SUBSTATION · ONLINE" : `SUBSTATION · ${online}/${feeders.length} FEEDERS UP`;
    substation.classList.toggle("warn", online < feeders.length);
}

function toggleFeeder(i) {
    const feeder = feeders[i];
    feeder.online = !feeder.online;
    const affected = Object.keys(BARANGAYS).filter((name) => BARANGAYS[name].feeder === i);

    if (!feeder.online) {
        feeder.loss = 100;
        log(`Feeder ${i + 1} link cut. ${affected.join(" and ")} lost power.`, "bad");
        const created = [];
        affected.forEach((name) => {
            const hasActive = outages.some((o) => o.barangay === name && o.status !== "restored");
            if (!hasActive) {
                created.push(
                    addOutage({
                        barangay: name,
                        address: "Detected by network monitor",
                        households: 25 + Math.floor(Math.random() * 40),
                        auto: i,
                        cause: "Feeder link down"
                    })
                );
            }
        });
        if (created.length) log(`Auto-created report ${created.map((o) => "#" + o.id).join(", ")} on the Admin Board.`);
        toast(`Feeder ${i + 1} is down. ${affected.length} barangays have no power.`, "danger");
    } else {
        feeder.latency = 18;
        feeder.loss = 0;
        log(`Feeder ${i + 1} link restored.`, "good");
        const fixed = outages.filter((o) => o.auto === i && o.status !== "restored");
        fixed.forEach((o) => {
            o.status = "restored";
            o.eta = estimateRestoration(o);
        });
        if (fixed.length) log(`Marked ${fixed.map((o) => "#" + o.id).join(", ")} as restored.`, "good");
        toast(`Feeder ${i + 1} is back online`, "success");
    }
    renderAll();
}

$$(".cut-button").forEach((button, i) => button.addEventListener("click", () => toggleFeeder(i)));

$(".network-barangays").addEventListener("click", (e) => {
    const button = e.target.closest(".net-brgy");
    if (!button) return;
    const name = button.dataset.barangay;
    const active = outages.find((o) => o.barangay === name && o.status !== "restored");
    if (active) showOnMap(active.id);
    else toast(`${name} has power and no active outages`, "success");
});

$$(".proto").forEach((chip) => chip.addEventListener("click", () => toast(chip.dataset.info, "info")));

// Simulated heartbeat: online feeders report new latency every 2 seconds
setInterval(() => {
    feeders.forEach((f) => {
        if (!f.online) return;
        f.latency = 12 + Math.floor(Math.random() * 30);
        f.loss = Math.random() < 0.12 ? 1 : 0;
    });
    renderNetwork();
}, 2000);

/* ---------- render everything ---------- */
function renderAll() {
    renderStats();
    renderTabs();
    renderAreaStatus();
    renderMarkers();
    renderAdmin();
    renderCard();
    renderNetwork();
    renderForecast();
    renderHistory();
    try {
        localStorage.setItem("powergrid_live_state", JSON.stringify({ outages, feeders, selectedId }));
    } catch {
        // The interface can still run when browser storage is unavailable.
    }
}

/* ---------- start ---------- */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}

function updateConnectivity() {
    const banner = $("#offline-banner");
    if (banner) banner.hidden = navigator.onLine;
    if (navigator.onLine) syncPendingFeedback();
}

async function syncPendingFeedback() {
    if (!pendingFeedback.length) return;
    const unsent = [];
    for (const item of pendingFeedback) {
        try {
            const response = await fetch("./api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(item)
            });
            if (!response.ok) unsent.push(item);
        } catch {
            unsent.push(item);
        }
    }
    pendingFeedback = unsent;
    localStorage.setItem(FEEDBACK_PENDING_KEY, JSON.stringify(pendingFeedback));
}

window.addEventListener("online", updateConnectivity);
window.addEventListener("offline", updateConnectivity);

renderAreaAdmin();
renderUserAdmin();
initMap();
log("Simulated nodes connected over HTTPS and WebSocket");
renderAll();
renderFeedback();
markDefaultBarangay();
setStep(1, true);
syncSliders();
updateConnectivity();

// Let the forecast bars grow after first paint
setTimeout(() => {
    $$(".risk").forEach((card) => {
        $(".bar b", card).style.width = `${card.dataset.risk}%`;
    });
}, 250);

// Soft ripple where you press a button
document.addEventListener("pointerdown", (e) => {
    const button = e.target.closest("button");
    if (!button || button.disabled) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
    button.append(ripple);
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    setTimeout(() => ripple.remove(), 900);
});

/* ---------- log out + welcome ---------- */
$("#logout-button").addEventListener("click", () => {
    document.body.classList.add("signing-out");
    Auth.logout();
    setTimeout(() => location.replace("login.html"), 380);
});

if (sessionStorage.getItem("pg_welcome")) {
    sessionStorage.removeItem("pg_welcome");
    setTimeout(() => toast(`Welcome, ${user.name.split(" ")[0]}${isStaff ? " (staff)" : ""}`, "success"), 400);
}
