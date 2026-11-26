"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const HOME_PAGE = "index.html";

// Already logged in? Go straight to the app.
if (Auth.currentUser()) location.replace(HOME_PAGE);

const TEXT = {
    login: ["Welcome back", "Log in to report outages and follow repairs in your barangay."],
    register: ["Create your account", "Residents can report outages and get updates for their barangay."]
};

let mode = "login";
let panelToken = 0;

/* ---------- barangay list + demo account ---------- */
Auth.getBarangays()
    .then((names) => names.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        $("#reg-barangay").append(option);
    }))
    .catch((error) => {
        $("#register-error").textContent = error.message;
    });
$("#demo-email").textContent = Auth.DEMO_ADMIN.email;
$("#demo-password").textContent = Auth.DEMO_ADMIN.password;

/* ---------- switching between Log in and Create account ---------- */
function setMode(next, instant = false) {
    if (next === mode && !instant) return;
    const direction = next === "register" ? "fwd" : "back";
    mode = next;

    $(".auth-tabs").dataset.mode = next;
    $$(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === next));
    $("#auth-title").textContent = TEXT[next][0];
    $("#auth-sub").textContent = TEXT[next][1];
    document.title = `${next === "login" ? "Log in" : "Create account"} · PowerGrid Outage Tracker`;
    history.replaceState(null, "", next === "register" ? "#register" : "#login");

    const panels = $$(".auth-panel");
    const target = panels.find((p) => p.dataset.mode === next);
    const current = panels.find((p) => p.classList.contains("active"));
    const token = ++panelToken;
    const show = () => {
        if (token !== panelToken) return;
        panels.forEach((p) => p.classList.remove("active", "leaving", "fwd", "back"));
        target.classList.add("active", direction);
        const first = $("input, select", target);
        if (first && !instant) first.focus({ preventScroll: true });
    };
    if (instant || !current || current === target) {
        show();
    } else {
        current.classList.add("leaving", direction);
        setTimeout(show, 180);
    }
    clearErrors();
}

$$(".auth-tab").forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

/* ---------- small helpers ---------- */
function clearErrors() {
    $$(".field").forEach((field) => {
        field.classList.remove("invalid");
        $(".field-error", field).textContent = "";
    });
    $$(".form-error").forEach((el) => (el.textContent = ""));
}

function showFieldErrors(form, errors) {
    let firstInvalid = null;
    Object.entries(errors).forEach(([name, message]) => {
        const input = form.elements[name];
        if (!input) return;
        const field = input.closest(".field");
        field.classList.add("invalid");
        $(".field-error", field).textContent = message;
        input.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) firstInvalid.focus();
}

// Typing in a field clears its own error
$$(".field input, .field select").forEach((input) =>
    input.addEventListener("input", () => {
        const field = input.closest(".field");
        field.classList.remove("invalid");
        $(".field-error", field).textContent = "";
        input.removeAttribute("aria-invalid");
        $$(".form-error").forEach((el) => (el.textContent = ""));
    })
);

function setBusy(form, busy) {
    const button = $(".auth-submit", form);
    button.disabled = busy;
    button.textContent = busy ? "Please wait…" : form.id === "login-form" ? "Log in" : "Create account";
}

function goHome() {
    sessionStorage.setItem("pg_welcome", "1");
    $("#auth-card").classList.add("leaving");
    setTimeout(() => location.replace(HOME_PAGE), 380);
}

/* ---------- show / hide password ---------- */
$$("[data-toggle]").forEach((button) =>
    button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.toggle);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "Hide" : "Show";
        button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    })
);

/* ---------- password strength meter ---------- */
$("#reg-password").addEventListener("input", (e) => {
    const level = Auth.passwordStrength(e.target.value);
    const labels = ["", "Weak", "Okay", "Good", "Strong"];
    $("#strength").dataset.level = level;
    $("#strength-label").textContent = labels[level];
});

/* ---------- demo account helper ---------- */
$("#demo-fill").addEventListener("click", () => {
    $("#login-email").value = Auth.DEMO_ADMIN.email;
    $("#login-password").value = Auth.DEMO_ADMIN.password;
    $("#login-password").focus();
});

/* ---------- log in ---------- */
$("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors();
    setBusy(form, true);
    const result = await Auth.login(form.elements.email.value, form.elements.password.value, $("#login-remember").checked);
    if (result.ok) {
        goHome();
        return;
    }
    setBusy(form, false);
    $("#login-error").textContent = result.error;
});

/* ---------- register ---------- */
$("#register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearErrors();
    setBusy(form, true);
    const result = await Auth.register({
        name: form.elements.name.value,
        email: form.elements.email.value,
        barangay: form.elements.barangay.value,
        password: form.elements.password.value,
        confirm: form.elements.confirm.value
    });
    if (result.ok) {
        goHome();
        return;
    }
    setBusy(form, false);
    showFieldErrors(form, result.errors);
    $("#register-error").textContent = "Please fix the highlighted fields.";
});

/* ---------- start ---------- */
setMode(location.hash === "#register" ? "register" : "login", true);

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}
