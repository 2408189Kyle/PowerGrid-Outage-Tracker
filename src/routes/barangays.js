"use strict";

const express = require("express");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");

const router = express.Router();
const numberInput = (schema) => z.preprocess(
    (value) => typeof value === "string" && value.trim() ? Number(value) : value,
    schema
);
const coordinate = z.number();
const areaSchema = z.object({
    name: z.string().trim().min(2).max(100),
    latitude: numberInput(coordinate.min(13.65).max(13.84)),
    longitude: numberInput(coordinate.min(120.96).max(121.16)),
    feeder_id: numberInput(z.number().int().positive()),
    households_estimate: numberInput(z.number().int().min(0).max(100000)).optional().default(1000)
});

function publicArea(row) {
    return {
        ...row,
        latitude: row.latitude === null ? null : Number(row.latitude),
        longitude: row.longitude === null ? null : Number(row.longitude),
        feeder_id: row.feeder_id === null ? null : Number(row.feeder_id),
        boundary_available: Boolean(row.boundary_available)
    };
}

const areaSelect = `SELECT b.id, b.name, b.households_estimate, b.feeder_id,
                           f.name AS feeder_name,
                           ST_Y(b.location) AS latitude, ST_X(b.location) AS longitude,
                           b.boundary IS NOT NULL AS boundary_available
                    FROM barangays b
                    LEFT JOIN feeders f ON f.id = b.feeder_id`;

router.get("/feeders", async (_req, res, next) => {
    try {
        const result = await query("SELECT id, name FROM feeders ORDER BY id");
        return res.json({ ok: true, feeders: result.rows });
    } catch (error) {
        return next(error);
    }
});

router.get("/", async (_req, res, next) => {
    try {
        const result = await query(`${areaSelect} ORDER BY b.name`);
        return res.json({ ok: true, barangays: result.rows.map(publicArea) });
    } catch (error) {
        return next(error);
    }
});

router.post("/", requireAuth, requireAdmin, async (req, res, next) => {
    const parsed = areaSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a name, valid Batangas City coordinates, and a feeder." });
    }
    try {
        const result = await query(
            `INSERT INTO barangays (name, location, feeder_id, households_estimate)
             VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5)
             RETURNING id, name, households_estimate, feeder_id,
                       ST_Y(location) AS latitude, ST_X(location) AS longitude,
                       boundary IS NOT NULL AS boundary_available`,
            [
                parsed.data.name,
                parsed.data.latitude,
                parsed.data.longitude,
                parsed.data.feeder_id,
                parsed.data.households_estimate
            ]
        );
        return res.status(201).json({ ok: true, barangay: publicArea(result.rows[0]) });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({ ok: false, error: "A barangay with this name already exists." });
        }
        if (error.code === "23503") {
            return res.status(400).json({ ok: false, error: "Choose an existing feeder." });
        }
        return next(error);
    }
});

router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const parsed = areaSchema.safeParse(req.body);
    if (!id.success || !parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a valid barangay ID and complete area details." });
    }
    try {
        const result = await query(
            `UPDATE barangays
             SET name = $2,
                 location = ST_SetSRID(ST_MakePoint($4, $3), 4326),
                 feeder_id = $5,
                 households_estimate = $6
             WHERE id = $1
             RETURNING id, name, households_estimate, feeder_id,
                       ST_Y(location) AS latitude, ST_X(location) AS longitude,
                       boundary IS NOT NULL AS boundary_available`,
            [
                id.data,
                parsed.data.name,
                parsed.data.latitude,
                parsed.data.longitude,
                parsed.data.feeder_id,
                parsed.data.households_estimate
            ]
        );
        if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Barangay not found." });
        return res.json({ ok: true, barangay: publicArea(result.rows[0]) });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({ ok: false, error: "A barangay with this name already exists." });
        }
        if (error.code === "23503") {
            return res.status(400).json({ ok: false, error: "Choose an existing feeder." });
        }
        return next(error);
    }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: "Invalid barangay ID." });
    try {
        const count = await query("SELECT count(*)::int AS total FROM barangays");
        if (count.rows[0].total <= 1) {
            return res.status(409).json({ ok: false, error: "At least one barangay must remain." });
        }
        const result = await query("DELETE FROM barangays WHERE id = $1 RETURNING id", [id.data]);
        if (!result.rows[0]) return res.status(404).json({ ok: false, error: "Barangay not found." });
        return res.json({ ok: true, id: result.rows[0].id });
    } catch (error) {
        if (error.code === "23503") {
            return res.status(409).json({ ok: false, error: "This barangay has user, outage, or sensor history and cannot be removed." });
        }
        return next(error);
    }
});

module.exports = router;
