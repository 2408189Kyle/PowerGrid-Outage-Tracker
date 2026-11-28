"use strict";

const express = require("express");
const { z } = require("zod");
const { pool, query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();

router.get("/feeders", requireAuth, async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT f.id, f.name,
                    NOT EXISTS (
                        SELECT 1
                        FROM barangays b
                        JOIN incidents i ON i.barangay_id = b.id
                        WHERE b.feeder_id = f.id
                          AND i.source = 'system'
                          AND i.cause = 'Simulated feeder fault'
                          AND i.status <> 'Restored'
                    ) AS online
             FROM feeders f
             ORDER BY f.id`
        );
        return res.json({
            ok: true,
            feeders: result.rows.map((feeder) => ({
                id: Number(feeder.id),
                name: feeder.name,
                online: Boolean(feeder.online)
            }))
        });
    } catch (error) {
        return next(error);
    }
});

router.patch("/feeders/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const parsed = z.object({ online: z.boolean() }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a valid feeder ID and online state." });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const feeder = await client.query(
            "SELECT id FROM feeders WHERE id = $1 FOR UPDATE",
            [id.data]
        );
        if (!feeder.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "Feeder not found." });
        }

        const areas = await client.query(
            "SELECT name FROM barangays WHERE feeder_id = $1 ORDER BY name",
            [id.data]
        );
        if (!areas.rows.length) {
            await client.query("ROLLBACK");
            return res.status(409).json({ ok: false, error: "This feeder has no assigned barangays." });
        }

        if (parsed.data.online) {
            await client.query(
                `UPDATE incidents AS i
                 SET status = 'Restored',
                     restored_at = COALESCE(i.restored_at, now())
                 FROM barangays AS b
                 WHERE i.barangay_id = b.id
                   AND b.feeder_id = $1
                   AND i.source = 'system'
                   AND i.cause = 'Simulated feeder fault'
                   AND i.status <> 'Restored'`,
                [id.data]
            );
        } else {
            await client.query(
                `INSERT INTO incidents
                    (barangay_id, center, status, source, cause, started_at,
                     report_count, est_households)
                 SELECT b.id,
                        COALESCE(b.location, ST_SetSRID(ST_MakePoint(121.0583, 13.7567), 4326)),
                        'Reported', 'system', 'Simulated feeder fault', now(),
                        1, GREATEST(COALESCE(b.households_estimate, 1), 1)
                 FROM barangays AS b
                 WHERE b.feeder_id = $1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM incidents AS i
                       WHERE i.barangay_id = b.id
                         AND i.source = 'system'
                         AND i.cause = 'Simulated feeder fault'
                         AND i.status <> 'Restored'
                   )`,
                [id.data]
            );
        }

        await client.query("COMMIT");
        return res.json({
            ok: true,
            feeder: { id: id.data, online: parsed.data.online },
            affected_barangays: areas.rows.map((area) => area.name)
        });
    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Could not roll back feeder simulation:", rollbackError.message);
            }
        }
        return next(error);
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
