"use strict";

const LITE_DB_NAME = "powergrid-lite";
const LITE_DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const REPORT_STORE = "reports";
const MAP_BOUNDS = { south: 13.65, west: 120.96, north: 13.84, east: 121.16 };
const BARANGAYS = {
    "Poblacion": [13.7567, 121.0583],
    "Alangilan": [13.7810, 121.0638],
    "Pallocan West": [13.7648, 121.0415],
    "Kumintang Ibaba": [13.7485, 121.0512],
    "Bolbok": [13.7722, 121.0528],
    "Sta. Rita Karsada": [13.7460, 121.0690]
};

const $ = (selector) => document.querySelector(selector);
let liteDb;
let refreshInProgress = false;
let syncInProgress = false;

function openLiteDb() {
    if (!("indexedDB" in window)) {
        return Promise.reject(new Error("This browser cannot store Lite data offline."));
    }
    if (!liteDb) {
        liteDb = new Promise((resolve, reject) => {
            const request = indexedDB.open(LITE_DB_NAME, LITE_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
                    db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains(REPORT_STORE)) {
                    db.createObjectStore(REPORT_STORE, { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not open Lite's offline storage."));
            request.onblocked = () => reject(new Error("Lite storage is busy in another tab."));
        }).catch((error) => {
            liteDb = null;
            throw error;
        });
    }
    return liteDb;
}

function withStore(storeName, mode, action) {
    return openLiteDb().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));
        let result;
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error || new Error("Could not read Lite's offline storage."));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error("Lite's offline storage failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Lite's offline storage was interrupted."));
    }));
}

function currentOwner() {
    const user = typeof Auth !== "undefined" ? Auth.currentUser() : null;
    return user ? String(user.email || user.id || "").trim().toLowerCase() : "";
}

function setConnectionStatus(message, detail, online) {
    const status = $("#connection-status");
    status.classList.toggle("offline", !online);
    $("#connection-label").textContent = message;
    $("#connection-detail").textContent = detail;
    $("#offline-note").hidden = online;
}

function updateNetworkIndicator() {
    if (navigator.onLine) {
        setConnectionStatus("Connection not checked", "Tap Refresh when ready", false);
    } else {
        setConnectionStatus("No network connection", "Saved data only", false);
    }
}

function statusKey(incident) {
    const value = String(incident.ui_status || incident.status || "").toLowerCase();
    if (value.includes("repair")) return "repair";
    if (value.includes("verif")) return "verified";
    if (value.includes("restor")) return "restored";
    return "reported";
}

function statusLabel(status) {
    return {
        reported: "Reported",
        verified: "Verified",
        repair: "Under repair",
        restored: "Restored"
    }[status] || "Reported";
}

function incidentCoordinates(incident) {
    const latitude = Number(incident.latitude);
    const longitude = Number(incident.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < MAP_BOUNDS.south || latitude > MAP_BOUNDS.north
        || longitude < MAP_BOUNDS.west || longitude > MAP_BOUNDS.east) return null;
    return { latitude, longitude };
}

function renderMapMarkers(incidents) {
    const layer = $("#incident-markers");
    layer.replaceChildren();
    incidents.forEach((incident) => {
        const coordinates = incidentCoordinates(incident);
        if (!coordinates) return;
        const x = 70 + ((coordinates.longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * 660;
        const y = 40 + ((MAP_BOUNDS.north - coordinates.latitude) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * 680;
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        const status = statusKey(incident);
        marker.setAttribute("class", `incident-marker ${status}`);
        marker.setAttribute("cx", String(x));
        marker.setAttribute("cy", String(y));
        marker.setAttribute("r", "11");
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = `${incident.barangay || "Outage"} · ${statusLabel(status)}`;
        marker.append(title);
        layer.append(marker);
    });
}

function renderIncidents(incidents, updatedAt) {
    const active = incidents.filter((incident) => statusKey(incident) !== "restored");
    const affected = active.reduce((sum, incident) => {
        const households = Number(incident.est_households ?? incident.households ?? 0);
        return sum + (Number.isFinite(households) ? households : 0);
    }, 0);
    $("#active-count").textContent = String(active.length);
    $("#affected-count").textContent = String(affected);
    $("#updated-at").textContent = updatedAt ? new Date(updatedAt).toLocaleString() : "Not saved";
    renderMapMarkers(incidents);

    const list = $("#outage-list");
    list.replaceChildren();
    if (incidents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No outage reports were in the last saved update.";
        list.append(empty);
        return;
    }

    incidents.forEach((incident) => {
        const status = statusKey(incident);
        const card = document.createElement("article");
        card.className = "outage-card";
        const heading = document.createElement("h4");
        heading.textContent = `${incident.barangay || "Batangas City"}${incident.landmark ? ` · ${incident.landmark}` : ""}`;
        const details = document.createElement("p");
        const households = Number(incident.est_households ?? incident.households ?? 0);
        details.textContent = `${statusLabel(status)} · ${Number.isFinite(households) ? households : 0} households affected`;
        const badge = document.createElement("span");
        badge.className = `outage-status ${status}`;
        badge.textContent = statusLabel(status);
        card.append(heading, details, badge);
        list.append(card);
    });
}

async function loadSavedIncidents() {
    const snapshot = await withStore(SNAPSHOT_STORE, "readonly", (store) => store.get("incidents"));
    if (snapshot && Array.isArray(snapshot.incidents)) {
        renderIncidents(snapshot.incidents, snapshot.updatedAt);
        $("#outage-message").textContent = "Showing the last update saved on this device.";
    } else {
        renderIncidents([], null);
        $("#outage-message").textContent = "No outage snapshot saved yet. Refresh when you have a connection.";
    }
}

function formatQueueItem(record) {
    const item = document.createElement("article");
    item.className = "outage-card queue-item";
    const content = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = `${record.body.barangay} · ${record.body.landmark || "No landmark"}`;
    const detail = document.createElement("p");
    detail.textContent = `Saved ${new Date(record.createdAt).toLocaleString()}${record.lastError ? ` · Last sync: ${record.lastError}` : ""}`;
    content.append(heading, detail);
    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = "Waiting";
    const remove = document.createElement("button");
    remove.className = "secondary-button";
    remove.type = "button";
    remove.dataset.removeReport = record.id;
    remove.textContent = "Remove";
    item.append(content, label, remove);
    return item;
}

async function renderQueue() {
    const owner = currentOwner();
    const records = (await withStore(REPORT_STORE, "readonly", (store) => store.getAll()))
        .filter((record) => record.owner === owner)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    $("#queue-count").textContent = records.length ? `(${records.length})` : "";
    $("#queue-empty").hidden = records.length > 0;
    const list = $("#queue-list");
    list.hidden = records.length === 0;
    list.replaceChildren(...records.map(formatQueueItem));
    if (!owner && records.length === 0) {
        $("#queue-message").textContent = "Sign in on this device to create and sync reports.";
    }
}

function updateAccount() {
    const user = typeof Auth !== "undefined" ? Auth.currentUser() : null;
    const signedIn = Boolean(user);
    $("#login-link").hidden = signedIn;
    $("#signed-in-user").hidden = !signedIn;
    $("#signed-in-user").textContent = signedIn
        ? `Signed in: ${user.name || user.email || "resident"}`
        : "";
}

async function refreshOutages() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    const button = $("#refresh-outages");
    button.disabled = true;
    $("#outage-message").textContent = "Requesting the latest outage data…";
    try {
        const response = await Auth.request("/api/incidents");
        if (response.status === 0) throw new Error("Could not reach PowerGrid. Your saved snapshot was kept.");
        if (response.status < 200 || response.status >= 300 || !response.data.ok
            || !Array.isArray(response.data.incidents)) {
            throw new Error(response.data.error || `Could not refresh outage data (HTTP ${response.status}).`);
        }
        const snapshot = {
            key: "incidents",
            incidents: response.data.incidents,
            updatedAt: new Date().toISOString()
        };
        await withStore(SNAPSHOT_STORE, "readwrite", (store) => store.put(snapshot));
        renderIncidents(snapshot.incidents, snapshot.updatedAt);
        $("#outage-message").textContent = "Outage data saved on this device.";
        setConnectionStatus("PowerGrid reachable", "Refresh and sync manually", true);
    } catch (error) {
        $("#outage-message").textContent = error.message;
        setConnectionStatus(
            "PowerGrid unavailable",
            navigator.onLine ? "Refresh again when ready" : "No network connection",
            false
        );
    } finally {
        refreshInProgress = false;
        button.disabled = false;
    }
}

async function saveReport(event) {
    event.preventDefault();
    const owner = currentOwner();
    if (!owner) {
        $("#form-message").textContent = "Sign in while connected first. Keep your session on this device to report offline.";
        return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const barangay = String(formData.get("barangay") || "");
    const coordinates = BARANGAYS[barangay];
    if (!coordinates) {
        $("#form-message").textContent = "Choose one of the listed barangays.";
        return;
    }

    const body = {
        barangay,
        landmark: String(formData.get("landmark") || "").trim(),
        cause: "Unknown",
        latitude: coordinates[0],
        longitude: coordinates[1],
        households: Number(formData.get("households") || 1),
        notes: String(formData.get("details") || "").trim()
    };
    const minutesAgo = formData.get("started-at");
    if (minutesAgo !== "") {
        body.started_at = new Date(Date.now() - Number(minutesAgo) * 60000).toISOString();
    }

    const record = {
        id: `lite:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        owner,
        body,
        createdAt: new Date().toISOString(),
        lastError: ""
    };
    try {
        await withStore(REPORT_STORE, "readwrite", (store) => store.put(record));
        form.reset();
        $("#form-message").textContent = "Report saved on this device. It will only be sent when you tap Sync.";
        await renderQueue();
    } catch (error) {
        $("#form-message").textContent = `Could not save this report locally: ${error.message}`;
    }
}

async function syncReports() {
    if (syncInProgress) return;
    const owner = currentOwner();
    if (!owner) {
        $("#queue-message").textContent = "Sign in with the account used to save these reports.";
        return;
    }
    if (!navigator.onLine) {
        $("#queue-message").textContent = "No network connection. Reports remain saved on this device.";
        return;
    }

    syncInProgress = true;
    const button = $("#sync-reports");
    button.disabled = true;
    let synced = 0;
    try {
        const records = (await withStore(REPORT_STORE, "readonly", (store) => store.getAll()))
            .filter((record) => record.owner === owner)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        if (records.length === 0) {
            $("#queue-message").textContent = "There are no reports waiting to sync.";
            return;
        }

        for (const record of records) {
            const response = await Auth.request("/api/incidents/reports", {
                method: "POST",
                body: record.body
            });
            if (response.status === 0) {
                $("#queue-message").textContent = "PowerGrid could not be reached. Remaining reports are still saved.";
                break;
            }
            if (response.status < 200 || response.status >= 300 || !response.data.ok) {
                record.lastError = response.status === 401
                    ? "Sign in again before syncing."
                    : response.data.error || `HTTP ${response.status}`;
                await withStore(REPORT_STORE, "readwrite", (store) => store.put(record));
                $("#queue-message").textContent = record.lastError;
                if (response.status === 401) {
                    $("#login-link").hidden = false;
                    $("#signed-in-user").hidden = true;
                    break;
                }
                continue;
            }
            await withStore(REPORT_STORE, "readwrite", (store) => store.delete(record.id));
            synced++;
        }
        if (synced > 0) {
            $("#queue-message").textContent = `${synced} report${synced === 1 ? "" : "s"} synced.`;
            setConnectionStatus("PowerGrid reachable", "Sync is always manual", true);
        }
        await renderQueue();
    } catch (error) {
        $("#queue-message").textContent = `Could not sync reports: ${error.message}`;
    } finally {
        syncInProgress = false;
        button.disabled = false;
    }
}

function activateTab(tab) {
    document.querySelectorAll('[role="tab"]').forEach((item) => {
        const active = item === tab;
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[role="tabpanel"]').forEach((page) => {
        page.hidden = page.id !== tab.getAttribute("aria-controls");
    });
}

document.querySelectorAll('[role="tab"]').forEach((tab, index, tabs) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const nextTab = tabs[(index + direction + tabs.length) % tabs.length];
        activateTab(nextTab);
        nextTab.focus();
    });
});

$("#refresh-outages").addEventListener("click", refreshOutages);
$("#sync-reports").addEventListener("click", syncReports);
$("#report-form").addEventListener("submit", saveReport);
$("#queue-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-report]");
    if (!button) return;
    try {
        await withStore(REPORT_STORE, "readwrite", (store) => store.delete(button.dataset.removeReport));
        $("#queue-message").textContent = "Saved report removed from this device.";
        await renderQueue();
    } catch (error) {
        $("#queue-message").textContent = `Could not remove the report: ${error.message}`;
    }
});
window.addEventListener("online", updateNetworkIndicator);
window.addEventListener("offline", updateNetworkIndicator);

updateAccount();
updateNetworkIndicator();
loadSavedIncidents().catch((error) => {
    $("#outage-message").textContent = `Could not read saved outage data: ${error.message}`;
});
renderQueue().catch((error) => {
    $("#queue-message").textContent = `Could not read the report queue: ${error.message}`;
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((error) => {
            console.error("Could not register the offline app shell:", error);
            $("#offline-note").hidden = false;
            $("#offline-note").textContent = "Offline app caching could not be enabled. Keep a connection available while using Lite.";
        });
    });
}
