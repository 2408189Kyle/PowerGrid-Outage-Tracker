"use strict";

const express = require("express");
const { z } = require("zod");
const { pool, query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get("/", async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at,
                    b.name AS barangay
             FROM users u
             LEFT JOIN barangays b ON b.id = u.barangay_id
             ORDER BY u.created_at DESC, u.id DESC`
        );
        return res.json({ ok: true, users: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.patch("/:id", async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const parsed = z.object({
        name: z.string().trim().min(2).max(100).optional(),
        email: z.string().trim().email().max(254).optional(),
        role: z.enum(["resident", "admin"]).optional(),
        is_active: z.boolean().optional()
    }).refine((fields) => Object.keys(fields).length > 0).safeParse(req.body);
    if (!id.success || !parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a valid user ID and fields to update." });
    }
    if (String(id.data) === String(req.user.sub) &&
        (parsed.data.role !== undefined || parsed.data.is_active === false)) {
        return res.status(400).json({ ok: false, error: "You cannot change your own role or deactivate your account." });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
        const current = await client.query(
            "SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE",
            [id.data]
        );
        if (!current.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "User not found." });
        }
        const losesAdminAccess =
            current.rows[0].role === "admin" &&
            current.rows[0].is_active &&
            (parsed.data.role === "resident" || parsed.data.is_active === false);
        if (losesAdminAccess) {
            const count = await client.query(
                "SELECT count(*)::int AS active_admins FROM users WHERE role = 'admin' AND is_active = true"
            );
            if (count.rows[0].active_admins <= 1) {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "The last active administrator cannot be demoted or deactivated." });
            }
        }

        const result = await client.query(
            `UPDATE users
             SET name = COALESCE($2, name),
                 email = COALESCE($3, email),
                 role = COALESCE($4, role),
                 is_active = COALESCE($5, is_active)
             WHERE id = $1
             RETURNING id, name, email, role, is_active`,
            [
                id.data,
                parsed.data.name,
                parsed.data.email && parsed.data.email.toLowerCase(),
                parsed.data.role,
                parsed.data.is_active
            ]
        );
        await client.query("COMMIT");
        return res.json({ ok: true, user: result.rows[0] });
    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Could not roll back user update:", rollbackError.message);
            }
        }
        if (error.code === "23505") {
            return res.status(409).json({ ok: false, error: "An account with this email already exists." });
        }
        return next(error);
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
