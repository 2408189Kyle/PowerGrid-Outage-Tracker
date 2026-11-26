"use strict";

const express = require("express");
const { z } = require("zod");
const { pool, query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();

const statusMap = {
    Reported: "reported",
    Verified: "verified",
    "Under Repair": "repair",
    Restored: "restored"
};

const reportSchema = z.object({
    barangay: z.string().trim().min(1).max(100),
    landmark: z.string().trim().max(200).optional().default(""),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    started_at: z.string().datetime({ offset: true }).optional(),
    households: z.number().int().min(1).max(5000).default(1),
    notes: z.string().trim().max(2000).optional().default(""),
    photo_path: z.string().trim().max(500).optional()
});

router.get("/", async (req, res, next) => {
    try {
        const status = req.query.status;
        const allowed = ["Reported", "Verified", "Under Repair", "Restored"];
        const params = [];
        let clause = "";
        if (status && allowed.includes(status)) {
            params.push(status);
            clause = "WHERE i.status = $1";
        }
        const result = await query(
            `SELECT i.id, i.status, i.source, i.cause, i.started_at, i.verified_at,
                    i.restored_at, i.report_count, i.est_households,
                    i.predicted_restore_at, i.predicted_duration_min,
                    b.id AS barangay_id, b.name AS barangay,
                    ST_Y(i.center) AS latitude, ST_X(i.center) AS longitude
             FROM incidents i
             JOIN barangays b ON b.id = i.barangay_id
             ${clause}
             ORDER BY i.started_at DESC`,
            params
        );
        return res.json({
            ok: true,
            incidents: result.rows.map((row) => ({
                ...row,
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                ui_status: statusMap[row.status] || "reported"
            }))
        });
    } catch (error) {
        return next(error);
    }
});

router.post("/reports", requireAuth, async (req, res, next) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
        const errors = parsed.error.issues.reduce((all, issue) => {
            all[issue.path[0] || "request"] = issue.message;
            return all;
        }, {});
        return res.status(400).json({ ok: false, errors });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const area = await client.query(
            "SELECT id, name, households_estimate FROM barangays WHERE lower(name) = $1",
            [parsed.data.barangay.toLowerCase()]
        );
        if (!area.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(400).json({ ok: false, errors: { barangay: "Choose a listed barangay." } });
        }

        const location = `ST_SetSRID(ST_MakePoint($2, $3), 4326)`;
        const existing = await client.query(
            `SELECT id, report_count, est_households
             FROM incidents
             WHERE barangay_id = $1 AND status <> 'Restored'
               AND ST_DWithin(center::geography, ${location}::geography, 150)
             ORDER BY started_at DESC
             LIMIT 1`,
            [area.rows[0].id, parsed.data.longitude, parsed.data.latitude]
        );

        let incidentId;
        if (existing.rows[0]) {
            incidentId = existing.rows[0].id;
            await client.query(
                `UPDATE incidents
                 SET report_count = report_count + 1,
                     est_households = GREATEST(est_households, $2)
                 WHERE id = $1`,
                [incidentId, parsed.data.households]
            );
        } else {
            const incident = await client.query(
                `INSERT INTO incidents
                    (barangay_id, center, status, source, cause, started_at,
                     report_count, est_households)
                 VALUES ($1, ${location}, 'Reported', 'community', $4, COALESCE($5::timestamptz, now()), 1, $6)
                 RETURNING id`,
                [
                    area.rows[0].id,
                    parsed.data.longitude,
                    parsed.data.latitude,
                    parsed.data.notes || "Community report",
                    parsed.data.started_at || null,
                    parsed.data.households
                ]
            );
            incidentId = incident.rows[0].id;
        }

        const report = await client.query(
            `INSERT INTO reports
                (user_id, incident_id, barangay_id, landmark, location, started_at, notes, photo_path)
             VALUES ($1, $2, $3, $4,
                     ST_SetSRID(ST_MakePoint($5, $6), 4326),
                     COALESCE($7::timestamptz, now()), $8, $9)
             RETURNING id, incident_id, barangay_id, landmark, started_at, notes, photo_path, created_at`,
            [
                req.user.sub,
                incidentId,
                area.rows[0].id,
                parsed.data.landmark || null,
                parsed.data.longitude,
                parsed.data.latitude,
                parsed.data.started_at || null,
                parsed.data.notes || null,
                parsed.data.photo_path || null
            ]
        );
        await client.query("COMMIT");
        return res.status(201).json({ ok: true, incident_id: incidentId, report: report.rows[0] });
    } catch (error) {
        await client.query("ROLLBACK");
        return next(error);
    } finally {
        client.release();
    }
});

router.patch("/:id/status", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = z.object({
        status: z.enum(["Reported", "Verified", "Under Repair", "Restored"]),
        note: z.string().trim().max(1000).optional()
    }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, errors: { status: "Choose a valid incident status." } });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const current = await client.query(
            "SELECT status FROM incidents WHERE id = $1 FOR UPDATE",
            [req.params.id]
        );
        if (!current.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "Incident not found." });
        }

        const timestampFields = parsed.data.status === "Verified"
            ? ", verified_at = COALESCE(verified_at, now())"
            : parsed.data.status === "Restored"
                ? ", restored_at = COALESCE(restored_at, now())"
                : "";
        await client.query(
            `UPDATE incidents SET status = $1${timestampFields} WHERE id = $2`,
            [parsed.data.status, req.params.id]
        );
        await client.query(
            `INSERT INTO incident_updates
                (incident_id, admin_id, old_status, new_status, note)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.params.id, req.user.sub, current.rows[0].status, parsed.data.status, parsed.data.note || null]
        );
        await client.query("COMMIT");
        return res.json({ ok: true, incident_id: Number(req.params.id), status: parsed.data.status });
    } catch (error) {
        await client.query("ROLLBACK");
        return next(error);
    } finally {
        client.release();
    }
});

module.exports = router;
