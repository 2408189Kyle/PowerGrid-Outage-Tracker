"use strict";

const Auth = (() => {
    const USERS_KEY = "powergrid_users";
    const SESSION_KEY = "powergrid_session";

    const BARANGAYS = [
        "Poblacion",
        "Alangilan",
        "Pallocan West",
        "Kumintang Ibaba",
        "Bolbok",
        "Sta. Rita Karsada"
    ];

    const DEMO_ADMIN = {
        name: "PowerGrid Staff",
        email: "staff@powergrid.ph",
        password: "PowerGrid123",
        barangay: "Poblacion",
        role: "admin"
    };

    const read = (key, fallback) => {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch {
            return fallback;
        }
    };

    const readSession = () => {
        let session = null;
        try {
            const local = read(SESSION_KEY, null);
            if (local) session = local;
            else {
                const temporary = sessionStorage.getItem(SESSION_KEY);
                if (temporary) session = JSON.parse(temporary);
            }
        } catch {
            session = null;
        }
        return session;
    };

    const saveSession = (user, remember) => {
        sessionStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
        const session = JSON.stringify(user);
        if (remember) localStorage.setItem(SESSION_KEY, session);
        else sessionStorage.setItem(SESSION_KEY, session);
    };

    const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

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

    const getBarangays = () => {
        try {
            const saved = JSON.parse(localStorage.getItem("powergrid_areas"));
            if (Array.isArray(saved)) {
                const names = [...new Set(saved.map((area) => area && area.name).filter((name) => typeof name === "string"))];
                if (names.length) return names;
            }
        } catch {
            // Fall back to the built-in registration list.
        }
        return [...BARANGAYS];
    };

    return {
        BARANGAYS,
        DEMO_ADMIN,
        passwordStrength,
        getBarangays,

        currentUser() {
            const session = readSession();
            return session && session.email ? session : null;
        },

        guard() {
            if (!this.currentUser()) location.replace("login.html");
        },

        logout() {
            localStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(SESSION_KEY);
        },

        async login(email, password, remember = false) {
            await new Promise((resolve) => setTimeout(resolve, 180));
            email = normalizeEmail(email);
            password = String(password || "");

            if (email === normalizeEmail(DEMO_ADMIN.email) && password === DEMO_ADMIN.password) {
                saveSession(DEMO_ADMIN, remember);
                return { ok: true, user: DEMO_ADMIN };
            }

            const users = read(USERS_KEY, []);
            const user = users.find((item) => normalizeEmail(item.email) === email);
            if (!user || user.password !== password) {
                return { ok: false, error: "Email or password is incorrect." };
            }

            const sessionUser = { ...user };
            delete sessionUser.password;
            saveSession(sessionUser, remember);
            return { ok: true, user: sessionUser };
        },

        async register({ name, email, barangay, password, confirm }) {
            await new Promise((resolve) => setTimeout(resolve, 180));
            const errors = {};
            name = String(name || "").trim();
            email = normalizeEmail(email);
            password = String(password || "");
            confirm = String(confirm || "");

            if (name.length < 2) errors.name = "Enter your full name.";
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email address.";
            if (!getBarangays().includes(barangay)) errors.barangay = "Choose a barangay.";
            if (!validatePassword(password)) errors.password = "Use at least 8 characters and a number.";
            if (confirm !== password) errors.confirm = "Passwords do not match.";

            const users = read(USERS_KEY, []);
            if (email === normalizeEmail(DEMO_ADMIN.email) || users.some((item) => normalizeEmail(item.email) === email)) {
                errors.email = "An account with this email already exists.";
            }

            if (Object.keys(errors).length) return { ok: false, errors };

            const user = { name, email, barangay, password, role: "resident" };
            users.push(user);
            localStorage.setItem(USERS_KEY, JSON.stringify(users));

            const sessionUser = { ...user };
            delete sessionUser.password;
            saveSession(sessionUser, false);
            return { ok: true, user: sessionUser };
        }
    };
})();