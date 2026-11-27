"use strict";

const Auth = (() => {
    const SESSION_KEY = "powergrid_session";

    const BARANGAYS = [
        "Poblacion",
        "Alangilan",
        "Pallocan West",
        "Kumintang Ibaba",
        "Bolbok",
        "Sta. Rita Karsada"
    ];

    const readSession = () => {
        try {
            const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
            const session = raw ? JSON.parse(raw) : null;
            return session && session.user && session.token ? session : null;
        } catch {
            return null;
        }
    };

    const saveSession = (user, token, remember) => {
        sessionStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
        const session = JSON.stringify({ user, token });
        if (remember) localStorage.setItem(SESSION_KEY, session);
        else sessionStorage.setItem(SESSION_KEY, session);
    };

    const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
    const OFFLINE = "Cannot reach the login server. Start it with npm run dev, then open http://localhost:3002/Login.html (not Live Server or a local file).";

    const api = async (url, body, token, method) => {
        const headers = {};
        const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
        if (body !== undefined && !isFormData) headers["Content-Type"] = "application/json";
        if (token) headers.Authorization = `Bearer ${token}`;

        try {
            const response = await fetch(url, {
                method: method || (body === undefined ? "GET" : "POST"),
                headers,
                credentials: "same-origin",
                body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body)
            });
            const contentType = response.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) {
                return {
                    status: response.status,
                    data: { error: OFFLINE }
                };
            }
            const data = await response.json().catch(() => ({}));
            if (response.status === 404) {
                return { status: response.status, data: { error: OFFLINE } };
            }
            return { status: response.status, data };
        } catch {
            return { status: 0, data: {} };
        }
    };

    const passwordStrength = (password) => {
        if (!password) return 0;
        let level = password.length >= 8 ? 1 : 0;
        if (/[0-9]/.test(password)) level++;
        if (/[A-Z]/.test(password) && /[a-z]/.test(password)) level++;
        if (/[^A-Za-z0-9]/.test(password) && level < 4) level++;
        return Math.min(level, 4);
    };

    const validatePassword = (password) =>
        password.length >= 8 && /[0-9]/.test(password);

    const getBarangays = async () => {
        const { status, data } = await api("/api/barangays");
        if (status === 0 || status === 404) throw new Error(OFFLINE);
        if (!data.ok || !Array.isArray(data.barangays)) {
            throw new Error(data.error || "Could not load barangays.");
        }
        return data.barangays.map((barangay) => barangay.name);
    };

    return {
        BARANGAYS,
        passwordStrength,
        getBarangays,

        request(url, { method = "GET", body } = {}) {
            const session = readSession();
            return api(url, body, session ? session.token : null, method);
        },

        async requestImage(url) {
            const session = readSession();
            if (!session) throw new Error("Login required to view report photos.");

            let response;
            try {
                response = await fetch(url, {
                    headers: { Authorization: `Bearer ${session.token}` },
                    credentials: "same-origin"
                });
            } catch {
                throw new Error(OFFLINE);
            }
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || "Could not load a report photo.");
            }
            return URL.createObjectURL(await response.blob());
        },

        currentUser() {
            const session = readSession();
            return session ? session.user : null;
        },

        updateCurrentUser(user) {
            const session = readSession();
            if (!session) throw new Error("Login required to update your profile.");
            saveSession(user, session.token, Boolean(localStorage.getItem(SESSION_KEY)));
        },

        async guard() {
            const session = readSession();
            if (!session) return location.replace("Login.html");
            const { status, data } = await api("/api/auth/me", undefined, session.token);
            if (status === 401) {
                localStorage.removeItem(SESSION_KEY);
                sessionStorage.removeItem(SESSION_KEY);
                return location.replace("Login.html");
            }
            if (data.user) {
                saveSession(data.user, session.token, Boolean(localStorage.getItem(SESSION_KEY)));
            }
        },

        logout() {
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
        },

        async login(email, password, remember = false, audience = "resident") {
            const { status, data } = await api("/api/auth/login", {
                email: normalizeEmail(email),
                password: String(password || ""),
                audience,
                remember
            });
            if (status === 0) return { ok: false, error: OFFLINE };
            if (!data.ok) return { ok: false, error: data.error || "Login failed." };
            saveSession(data.user, data.token, remember);
            return { ok: true, user: data.user };
        },

        async register({ name, email, barangay, password, confirm }) {
            const { status, data } = await api("/api/auth/register", {
                name,
                email: normalizeEmail(email),
                barangay,
                password,
                confirm
            });
            if (status === 0) return { ok: false, errors: { email: OFFLINE } };
            if (!data.ok) return { ok: false, errors: data.errors || { email: data.error || "Registration failed." } };
            saveSession(data.user, data.token, false);
            return { ok: true, user: data.user };
        }
    };
})();