"use strict";

const express = require("express");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();
const announcementFields = {
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    type: z.enum(["maintenance", "advisory"]),
    barangay_id: z.number().int().positive().nullable(),
    starts_at: z.string().datetime({ offset: true }).nullable(),
    ends_at: z.string().datetime({ offset: true }).nullable()
};

const createSchema = z.object({
    title: announcementFields.title,
    body: announcementFields.body,
    type: announcementFields.type,
    barangay_id: announcementFields.barangay_id.optional(),
    starts_at: announcementFields.starts_at.optional(),
    ends_at: announcementFields.ends_at.optional()
}).superRefine((fields, context) => {
    if (fields.starts_at && fields.ends_at && Date.parse(fields.ends_at) < Date.parse(fields.starts_at)) {
        context.addIssue({ code: "custom", path: ["ends_at"], message: "End time must be after start time." });
    }
});

const updateSchema = z.object({
    title: announcementFields.title.optional(),
    body: announcementFields.body.optional(),
    type: announcementFields.type.optional(),
    barangay_id: announcementFields.barangay_id.optional(),
    starts_at: announcementFields.starts_at.optional(),
    ends_at: announcementFields.ends_at.optional()
}).refine((fields) => Object.keys(fields).length > 0);

const selectFields = `SELECT a.id, a.title, a.body, a.type, a.barangay_id, b.name AS barangay,
                             a.starts_at, a.ends_at, a.created_at
                      FROM announcements a
                      LEFT JOIN barangays b ON b.id = a.barangay_id`;

router.get("/", async (_req, res, next) => {
    try {
        const result = await query(
            `${selectFields}
             WHERE (a.starts_at IS NULL OR a.starts_at <= now())
               AND (a.ends_at IS NULL OR a.ends_at >= now())
             ORDER BY COALESCE(a.starts_at, a.created_at) DESC, a.id DESC`
        );
        return res.json({ ok: true, announcements: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.get("/manage", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
        const result = await query(`${selectFields} ORDER BY a.created_at DESC, a.id DESC`);
        return res.json({ ok: true, announcements: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid announcement details." });
    try {
        const result = await query(
            `INSERT INTO announcements
                (title, body, type, barangay_id, starts_at, ends_at, created_by)
             VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)
             RETURNING id, title, body, type, barangay_id, starts_at, ends_at, created_at`,
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
        if (error.code === "23503") {
            return res.status(400).json({ ok: false, error: "Choose an existing barangay." });
        }
        return next(error);
    }
});

router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const parsed = updateSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a valid announcement ID and fields to update." });
    }
    if (parsed.data.starts_at && parsed.data.ends_at &&
        Date.parse(parsed.data.ends_at) < Date.parse(parsed.data.starts_at)) {
        return res.status(400).json({ ok: false, error: "End time must be after start time." });
    }

    const columns = {
        title: "title",
        body: "body",
        type: "type",
        barangay_id: "barangay_id",
        starts_at: "starts_at",
        ends_at: "ends_at"
    };
    const values = [id.data];
    const updates = [];
    for (const [field, column] of Object.entries(columns)) {
        if (Object.prototype.hasOwnProperty.call(parsed.data, field)) {
            values.push(parsed.data[field]);
            updates.push(`${column} = $${values.length}${field === "starts_at" || field === "ends_at" ? "::timestamptz" : ""}`);
        }
    }

    try {
        const result = await query(
            `UPDATE announcements SET ${updates.join(", ")}
             WHERE id = $1
             RETURNING id, title, body, type, barangay_id, starts_at, ends_at, created_at`,
            values
        );
        if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Announcement not found." });
        return res.json({ ok: true, announcement: result.rows[0] });
    } catch (error) {
        if (error.code === "23503") {
            return res.status(400).json({ ok: false, error: "Choose an existing barangay." });
        }
        return next(error);
    }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: "Invalid announcement ID." });
    try {
        const result = await query("DELETE FROM announcements WHERE id = $1 RETURNING id", [id.data]);
        if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Announcement not found." });
        return res.json({ ok: true, id: result.rows[0].id });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
