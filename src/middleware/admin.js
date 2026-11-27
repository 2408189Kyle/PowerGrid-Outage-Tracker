"use strict";

const { query } = require("../config/db");

module.exports = async (req, res, next) => {
    if (!req.user) return res.status(403).json({ ok: false, error: "Administrator access required." });
    try {
        const result = await query(
            "SELECT role, is_active FROM users WHERE id = $1",
            [req.user.sub]
        );
        if (!result.rows[0] || !result.rows[0].is_active) {
            return res.status(401).json({ ok: false, error: "Account is unavailable." });
        }
        if (result.rows[0].role !== "admin") {
            return res.status(403).json({ ok: false, error: "Administrator access required." });
        }
        req.user.role = result.rows[0].role;
        return next();
    } catch (error) {
        return next(error);
    }
};
