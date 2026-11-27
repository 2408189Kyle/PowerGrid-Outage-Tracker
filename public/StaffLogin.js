"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const currentUser = Auth.currentUser();
if (currentUser && currentUser.role === "admin") location.replace("index.html#admin");

const form = $("#login-form");
const error = $("#login-error");

$$("[data-toggle]").forEach((button) =>
    button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.toggle);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "Hide" : "Show";
        button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    })
);

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const submit = $(".auth-submit", form);
    submit.disabled = true;
    submit.textContent = "Signing in…";

    const result = await Auth.login(
        form.elements.email.value,
        form.elements.password.value,
        $("#login-remember").checked,
        "staff"
    );

    if (result.ok) {
        sessionStorage.setItem("pg_welcome", "1");
        $("#auth-card").classList.add("leaving");
        setTimeout(() => location.replace("index.html#admin"), 380);
        return;
    }

    submit.disabled = false;
    submit.textContent = "Sign in to staff portal";
    error.textContent = result.error;
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}
