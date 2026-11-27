"use strict";

const express = require("express");
const { z } = require("zod");
const multer = require("multer");
const { pool, query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/admin");
const { getPhoto, removePhoto, storePhoto } = require("../services/photo-storage");

const router = express.Router();
const maxPhotoSize = 8 * 1024 * 1024;

const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxPhotoSize, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
            const error = new Error("Upload a JPG or PNG image.");
            error.statusCode = 400;
            return callback(error);
        }
        return callback(null, true);
    }
});

function parseReportPhoto(req, res, next) {
    photoUpload.single("photo")(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError) {
            const tooLarge = error.code === "LIMIT_FILE_SIZE";
            return res.status(tooLarge ? 413 : 400).json({
                ok: false,
                error: tooLarge ? "Photo must be 8 MB or smaller." : "Invalid photo upload."
            });
        }
        if (error.statusCode === 400) {
            return res.status(400).json({ ok: false, error: error.message });
        }
        return next(error);
    });
}

function validImageSignature(buffer, mimetype) {
    if (mimetype === "image/jpeg") {
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    return mimetype === "image/png" &&
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

const numberInput = (schema) => z.preprocess(
    (value) => typeof value === "string" && value.trim() ? Number(value) : value,
    schema
);

const statusMap = {
    Reported: "reported",
    Verified: "verified",
    "Under Repair": "repair",
    Restored: "restored"
};

const reportSchema = z.object({
    barangay: z.string().trim().min(1).max(100),
    landmark: z.string().trim().max(200).optional().default(""),
    cause: z.string().trim().max(100).optional().default("Unknown"),
    latitude: numberInput(z.number().min(-90).max(90)),
    longitude: numberInput(z.number().min(-180).max(180)),
    started_at: z.string().datetime({ offset: true }).optional(),
    households: numberInput(z.number().int().min(1).max(5000)).optional().default(1),
    notes: z.string().trim().max(2000).optional().default("")
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
                    ST_Y(i.center) AS latitude, ST_X(i.center) AS longitude,
                    report.landmark, report.notes, photo.photo_path,
                    report.reporter, COALESCE(report.created_at, i.started_at) AS created_at
             FROM incidents i
             JOIN barangays b ON b.id = i.barangay_id
             LEFT JOIN LATERAL (
                 SELECT r.landmark, r.notes, r.created_at,
                        u.name AS reporter
                 FROM reports r
                 JOIN users u ON u.id = r.user_id
                 WHERE r.incident_id = i.id
                 ORDER BY r.created_at DESC
                 LIMIT 1
             ) report ON true
             LEFT JOIN LATERAL (
                 SELECT r.photo_path
                 FROM reports r
                 WHERE r.incident_id = i.id AND r.photo_path IS NOT NULL
                 ORDER BY r.created_at DESC
                 LIMIT 1
             ) photo ON true
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
                photo_url: row.photo_path
                    ? `/api/incidents/${row.id}/photo?v=${encodeURIComponent(row.photo_path)}`
                    : null,
                ui_status: statusMap[row.status] || "reported"
            }))
        });
    } catch (error) {
        return next(error);
    }
});

router.get("/:id/photo", requireAuth, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: "Invalid incident ID." });

    try {
        const result = await query(
            `SELECT photo_path FROM reports
             WHERE incident_id = $1 AND photo_path IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 1`,
            [id.data]
        );
        const filename = result.rows[0] && result.rows[0].photo_path;
        if (!filename) return res.status(404).json({ ok: false, error: "Report photo not found." });

        res.setHeader("Cache-Control", "private, no-store");
        const photo = await getPhoto(filename);
        res.setHeader("Content-Type", photo.contentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        photo.body.on("error", next);
        return photo.body.pipe(res);
    } catch (error) {
        if (error.code === "ENOENT" || error.name === "NoSuchKey" || error.name === "NotFound") {
            return res.status(404).json({ ok: false, error: "Report photo file not found." });
        }
        return next(error);
    }
});

router.post("/reports", requireAuth, parseReportPhoto, async (req, res, next) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
        const errors = parsed.error.issues.reduce((all, issue) => {
            all[issue.path[0] || "request"] = issue.message;
            return all;
        }, {});
        return res.status(400).json({ ok: false, errors });
    }

    if (req.file && !validImageSignature(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ ok: false, error: "The uploaded file is not a valid JPG or PNG image." });
    }

    let client;
    let storedPhotoKey = null;
    try {
        if (req.file) storedPhotoKey = await storePhoto(req.file.buffer, req.file.mimetype);
        client = await pool.connect();
        await client.query("BEGIN");
        const area = await client.query(
            "SELECT id, name, households_estimate FROM barangays WHERE lower(name) = $1",
            [parsed.data.barangay.toLowerCase()]
        );
        if (!area.rows[0]) {
            await client.query("ROLLBACK");
            if (storedPhotoKey) {
                await removePhoto(storedPhotoKey);
                storedPhotoKey = null;
            }
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
                         est_households = est_households + $2
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
                    parsed.data.cause,
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
                storedPhotoKey
            ]
        );
        await client.query("COMMIT");
        storedPhotoKey = null;
        return res.status(201).json({ ok: true, incident_id: incidentId, report: report.rows[0] });
    } catch (error) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                console.error("Could not roll back report transaction:", rollbackError.message);
            }
        }
        if (storedPhotoKey) {
            try {
                await removePhoto(storedPhotoKey);
            } catch (cleanupError) {
                console.error("Could not remove unreferenced report photo:", cleanupError.message);
            }
        }
        return next(error);
    } finally {
        if (client) client.release();
    }
});

router.patch("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    const parsed = z.object({
        landmark: z.string().trim().min(1).max(200).optional(),
        households: z.number().int().min(1).max(5000).optional()
    }).refine((fields) => Object.keys(fields).length > 0).safeParse(req.body);
    if (!id.success || !parsed.success) {
        return res.status(400).json({ ok: false, error: "Provide a valid incident ID and fields to update." });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const incident = await client.query(
            "SELECT id FROM incidents WHERE id = $1 FOR UPDATE",
            [id.data]
        );
        if (!incident.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "Incident not found." });
        }
        if (parsed.data.households !== undefined) {
            await client.query(
                "UPDATE incidents SET est_households = $2 WHERE id = $1",
                [id.data, parsed.data.households]
            );
        }
        if (parsed.data.landmark !== undefined) {
            await client.query(
                `UPDATE reports
                 SET landmark = $2
                 WHERE id = (
                     SELECT id FROM reports
                     WHERE incident_id = $1
                     ORDER BY created_at DESC
                     LIMIT 1
                 )`,
                [id.data, parsed.data.landmark]
            );
        }
        await client.query("COMMIT");
        return res.json({ ok: true, incident_id: id.data });
    } catch (error) {
        await client.query("ROLLBACK");
        return next(error);
    } finally {
        client.release();
    }
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res, next) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ ok: false, error: "Invalid incident ID." });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const incident = await client.query(
            "SELECT id FROM incidents WHERE id = $1 FOR UPDATE",
            [id.data]
        );
        if (!incident.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "Incident not found." });
        }
        const photos = await client.query(
            "SELECT photo_path FROM reports WHERE incident_id = $1 AND photo_path IS NOT NULL",
            [id.data]
        );
        await client.query("DELETE FROM incident_updates WHERE incident_id = $1", [id.data]);
        await client.query("DELETE FROM reports WHERE incident_id = $1", [id.data]);
        await client.query("DELETE FROM incidents WHERE id = $1", [id.data]);
        await client.query("COMMIT");
        for (const photo of photos.rows) {
            try {
                await removePhoto(photo.photo_path);
            } catch (error) {
                console.error("Could not remove deleted incident photo:", error.message);
            }
        }
        return res.json({ ok: true, incident_id: id.data });
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
