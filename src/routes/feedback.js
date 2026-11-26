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
    comment: z.string().trim().min(1).max(2000),
    author: z.string().trim().max(100).optional()
});

router.post("/", async (req, res, next) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid feedback." });
    try {
        const area = await query(
            "SELECT id FROM barangays WHERE lower(name) = $1",
            [parsed.data.barangay.toLowerCase()]
        );
        if (!area.rows[0]) return res.status(400).json({ ok: false, error: "Choose a listed barangay." });
        const result = await query(
            `INSERT INTO community_feedback (barangay_id, location, comment, author_name)
             VALUES ($1, $2, $3, $4)
             RETURNING id, barangay_id, location, comment, author_name, created_at`,
            [area.rows[0].id, parsed.data.location, parsed.data.comment, parsed.data.author || null]
        );
        return res.status(201).json({ ok: true, feedback: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

router.get("/", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT f.id, f.location, f.comment, f.author_name, f.created_at,
                    b.name AS barangay
             FROM community_feedback f
             JOIN barangays b ON b.id = f.barangay_id
             ORDER BY f.created_at DESC
             LIMIT 200`
        );
        return res.json({ ok: true, feedback: result.rows });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
