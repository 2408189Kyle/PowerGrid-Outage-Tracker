"use strict";

require("dotenv").config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters.");
}

const express = require("express");
const helmet = require("helmet");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { query } = require("./config/db");
const authRoutes = require("./routes/auth");
const barangayRoutes = require("./routes/barangays");
const incidentRoutes = require("./routes/incidents");
const networkRoutes = require("./routes/network");
const announcementRoutes = require("./routes/announcements");
const feedbackRoutes = require("./routes/feedback");
const userRoutes = require("./routes/users");

const app = express();
const frontendPath = path.resolve(__dirname, "..", "frontend");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10kb" }));

app.get("/health", async (_req, res) => {
    try {
        await query("SELECT 1");
        return res.json({ ok: true, database: "up" });
    } catch (error) {
        console.error("Database health check failed:", error.message);
        return res.status(503).json({ ok: false, database: "down" });
    }
});

app.use("/api/auth", rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again in a few minutes."
    })
}), authRoutes);
app.use("/api/barangays", barangayRoutes);
app.use("/api/incidents", incidentRoutes);
app.use("/api/network", networkRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/users", userRoutes);
app.use(express.static(frontendPath));

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
app.use((_req, res) => res.sendStatus(404));

app.use((error, _req, res, _next) => {
    console.error(error);
    if (error.type === "entity.parse.failed") {
        return res.status(400).json({ ok: false, error: "Request body must be valid JSON." });
    }
    return res.status(500).json({ ok: false, error: "Server error." });
});

module.exports = app;
