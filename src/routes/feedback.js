"use strict";

const express = require("express");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();

const feedbackSchema = z.object({
    barangay: z.string().trim().min(1).max(100),
    location: z.string().trim().min(1).max(200),
    comment: z.string().trim().min(1).max(2000)
});

router.post("/", requireAuth, async (req, res, next) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid feedback." });
    try {
        const [area, account] = await Promise.all([
            query("SELECT id FROM barangays WHERE lower(name) = $1", [parsed.data.barangay.toLowerCase()]),
            query("SELECT name FROM users WHERE id = $1 AND is_active = true", [req.user.sub])
        ]);
        if (!account.rows[0]) return res.status(401).json({ ok: false, error: "Account is unavailable." });
        if (!area.rows[0]) return res.status(400).json({ ok: false, error: "Choose a listed barangay." });
        const result = await query(
            `INSERT INTO community_feedback (barangay_id, location, comment, author_name)
             VALUES ($1, $2, $3, $4)
             RETURNING id, barangay_id, location, comment, author_name, created_at`,
            [
                area.rows[0].id,
                parsed.data.location,
                parsed.data.comment,
                account.rows[0].name
            ]
        );
        return res.status(201).json({ ok: true, feedback: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

router.get("/", async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT f.id, f.location, f.comment, f.created_at,
                    b.name AS barangay
             FROM community_feedback f
             JOIN barangays b ON b.id = f.barangay_id
             ORDER BY f.created_at DESC
             LIMIT 20`
        );
        return res.json({ ok: true, feedback: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.delete("/", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
        await query("DELETE FROM community_feedback");
        return res.json({ ok: true });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
