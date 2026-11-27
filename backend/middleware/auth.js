"use strict";

const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

module.exports = async (req, res, next) => {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) return res.status(401).json({ ok: false, error: "Login required." });

    let claims;
    try {
        claims = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ ok: false, error: "Invalid or expired login. Please log in again." });
    }

    try {
        const result = await query(
            "SELECT role, is_active FROM users WHERE id = $1",
            [claims.sub]
        );
        if (!result.rows[0] || !result.rows[0].is_active) {
            return res.status(401).json({ ok: false, error: "Account is unavailable." });
        }
        req.user = { ...claims, role: result.rows[0].role };
        return next();
    } catch (error) {
        return next(error);
    }
};
