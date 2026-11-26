"use strict";

const express = require("express");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();

const announcementSchema = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    type: z.enum(["maintenance", "advisory"]),
    barangay_id: z.number().int().positive().optional().nullable(),
    starts_at: z.string().datetime({ offset: true }).optional().nullable(),
    ends_at: z.string().datetime({ offset: true }).optional().nullable()
});

router.get("/", async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT a.id, a.title, a.body, a.type, a.barangay_id, b.name AS barangay,
                    a.starts_at, a.ends_at
             FROM announcements a
             LEFT JOIN barangays b ON b.id = a.barangay_id
             WHERE (a.starts_at IS NULL OR a.starts_at <= now())
               AND (a.ends_at IS NULL OR a.ends_at >= now())
             ORDER BY COALESCE(a.starts_at, now()) DESC`,
            []
        );
        return res.json({ ok: true, announcements: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, errors: { request: "Invalid announcement." } });
    try {
        const result = await query(
            `INSERT INTO announcements
                (title, body, type, barangay_id, starts_at, ends_at, created_by)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)
             RETURNING id, title, body, type, barangay_id, starts_at, ends_at`,
            [
                parsed.data.title,
                parsed.data.body,
                parsed.data.type,
                parsed.data.barangay_id || null,
                parsed.data.starts_at || null,
                parsed.data.ends_at || null,
                req.user.sub
            ]
        );
        return res.status(201).json({ ok: true, announcement: result.rows[0] });
    } catch (error) {
        return next(error);
    }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
        const result = await query("DELETE FROM announcements WHERE id = $1 RETURNING id", [req.params.id]);
        if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Announcement not found." });
        return res.json({ ok: true, id: result.rows[0].id });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
