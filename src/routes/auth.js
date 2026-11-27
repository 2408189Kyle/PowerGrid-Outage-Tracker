"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");
const { getPhoto, isValidImageSignature, removePhoto, storePhoto } = require("../services/photo-storage");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);
const maxProfilePhotoSize = 2 * 1024 * 1024;
const profilePhotoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxProfilePhotoSize, files: 1 },
    fileFilter: (_req, file, callback) => {
        if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
            const error = new Error("Upload a JPG or PNG profile picture.");
            error.statusCode = 400;
            return callback(error);
        }
        return callback(null, true);
    }
});

const registerSchema = z.object({
    name: z.string().trim().min(2, "Enter your full name.").max(100, "Name is too long."),
    email: z.string().trim().email("Enter a valid email address.").max(254, "Email is too long."),
    barangay: z.string().trim().min(1, "Choose a barangay.").max(100, "Barangay name is too long."),
    password: z.string().min(8, "Use at least 8 characters and a number.").max(100, "Password is too long."),
    confirm: z.string(),
    remember: z.boolean().optional()
}).superRefine((fields, context) => {
    if (!/[0-9]/.test(fields.password)) {
        context.addIssue({
            code: "custom",
            path: ["password"],
            message: "Use at least 8 characters and a number."
        });
    }
    if (fields.password !== fields.confirm) {
        context.addIssue({
            code: "custom",
            path: ["confirm"],
            message: "Passwords do not match."
        });
    }
});

const loginSchema = z.object({
    email: z.string().trim().email("Enter a valid email address.").max(254),
    password: z.string().min(1, "Enter your password."),
    audience: z.enum(["resident", "staff"]),
    remember: z.boolean().optional()
});

const profileSchema = z.object({
    name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100, "Name is too long.")
});

function fieldErrors(issues) {
    return issues.reduce((errors, issue) => {
        const field = issue.path[0];
        if (typeof field === "string" && !errors[field]) errors[field] = issue.message;
        return errors;
    }, {});
}

function publicUser(user, barangay = null) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        barangay_id: user.barangay_id,
        barangay,
        profile_photo_url: user.profile_photo_path ? "/api/auth/me/photo" : null
    };
}

function parseProfilePhoto(req, res, next) {
    profilePhotoUpload.single("photo")(req, res, (error) => {
        if (!error) return next();
        if (error instanceof multer.MulterError) {
            const tooLarge = error.code === "LIMIT_FILE_SIZE";
            return res.status(tooLarge ? 413 : 400).json({
                ok: false,
                error: tooLarge ? "Profile picture must be 2 MB or smaller." : "Invalid profile picture upload."
            });
        }
        if (error.statusCode === 400) {
            return res.status(400).json({ ok: false, error: error.message });
        }
        return next(error);
    });
}

async function removeProfilePhoto(storedPath) {
    if (!storedPath) return;
    try {
        await removePhoto(storedPath);
    } catch (error) {
        console.error("Could not remove profile picture:", error.message);
    }
}

function createToken(user, remember) {
    return jwt.sign(
        { sub: String(user.id), role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: remember ? "7d" : "12h" }
    );
}

router.post("/register", async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, errors: fieldErrors(parsed.error.issues) });
    }

    const { name, password, remember } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    try {
        const area = await query(
            "SELECT id, name FROM barangays WHERE lower(name) = $1",
            [parsed.data.barangay.toLowerCase()]
        );
        if (!area.rows[0]) {
            return res.status(400).json({
                ok: false,
                errors: { barangay: "Choose a barangay listed by the server." }
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO users (name, email, password_hash, barangay_id, role)
             VALUES ($1, $2, $3, $4, 'resident')
             RETURNING id, name, email, role, barangay_id`,
            [name, email, passwordHash, area.rows[0].id]
        );
        const user = publicUser(result.rows[0], area.rows[0].name);
        return res.status(201).json({
            ok: true,
            user,
            token: createToken(user, Boolean(remember))
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                ok: false,
                errors: { email: "An account with this email already exists." }
            });
        }
        return next(error);
    }
});

router.post("/login", async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            ok: false,
            error: fieldErrors(parsed.error.issues).email || "Enter a valid email and password."
        });
    }

    const email = parsed.data.email.toLowerCase();

    try {
        const result = await query(
            `SELECT u.id, u.name, u.email, u.role, u.barangay_id, u.password_hash,
                    u.profile_photo_path,
                    b.name AS barangay
             FROM users u
             LEFT JOIN barangays b ON b.id = u.barangay_id
             WHERE lower(u.email) = $1 AND u.is_active = true`,
            [email]
        );
        const record = result.rows[0];
        const passwordMatches = await bcrypt.compare(
            parsed.data.password,
            record ? record.password_hash : DUMMY_HASH
        );
        const roleMatches = record && (
            (parsed.data.audience === "staff" && record.role === "admin") ||
            (parsed.data.audience === "resident" && record.role === "resident")
        );

        if (!record || !passwordMatches || !roleMatches) {
            return res.status(401).json({
                ok: false,
                error: "Email or password is incorrect, or this account cannot use this sign-in page."
            });
        }

        const user = publicUser(record, record.barangay);
        return res.json({
            ok: true,
            user,
            token: createToken(user, Boolean(parsed.data.remember))
        });
    } catch (error) {
        return next(error);
    }
});

router.get("/me", requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            `SELECT u.id, u.name, u.email, u.role, u.barangay_id,
                    u.profile_photo_path, b.name AS barangay
             FROM users u
             LEFT JOIN barangays b ON b.id = u.barangay_id
             WHERE u.id = $1 AND u.is_active = true`,
            [req.user.sub]
        );
        if (!result.rows[0]) {
            return res.status(401).json({ ok: false, error: "Account is unavailable." });
        }
        return res.json({ ok: true, user: publicUser(result.rows[0], result.rows[0].barangay) });
    } catch (error) {
        return next(error);
    }
});

router.patch("/me", requireAuth, parseProfilePhoto, async (req, res, next) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            ok: false,
            error: parsed.error.issues[0].message
        });
    }
    if (req.file && !isValidImageSignature(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({
            ok: false,
            error: "The uploaded file is not a valid JPG or PNG image."
        });
    }

    let storedPhotoPath = null;
    try {
        const current = await query(
            `SELECT u.profile_photo_path, b.name AS barangay
             FROM users u
             LEFT JOIN barangays b ON b.id = u.barangay_id
             WHERE u.id = $1 AND u.is_active = true`,
            [req.user.sub]
        );
        if (!current.rows[0]) {
            return res.status(401).json({ ok: false, error: "Account is unavailable." });
        }

        if (req.file) storedPhotoPath = await storePhoto(req.file.buffer, req.file.mimetype);
        const result = await query(
            `UPDATE users
             SET name = $2, profile_photo_path = COALESCE($3, profile_photo_path)
             WHERE id = $1 AND is_active = true
             RETURNING id, name, email, role, barangay_id, profile_photo_path`,
            [req.user.sub, parsed.data.name, storedPhotoPath]
        );
        if (!result.rows[0]) {
            await removeProfilePhoto(storedPhotoPath);
            storedPhotoPath = null;
            return res.status(401).json({ ok: false, error: "Account is unavailable." });
        }

        const previousPhotoPath = current.rows[0].profile_photo_path;
        const updatedUser = result.rows[0];
        if (storedPhotoPath) {
            storedPhotoPath = null;
            if (previousPhotoPath) await removeProfilePhoto(previousPhotoPath);
        }
        return res.json({
            ok: true,
            user: publicUser(updatedUser, current.rows[0].barangay)
        });
    } catch (error) {
        await removeProfilePhoto(storedPhotoPath);
        return next(error);
    }
});

router.get("/me/photo", requireAuth, async (req, res, next) => {
    try {
        const result = await query(
            "SELECT profile_photo_path FROM users WHERE id = $1 AND is_active = true",
            [req.user.sub]
        );
        const storedPath = result.rows[0] && result.rows[0].profile_photo_path;
        if (!storedPath) return res.status(404).json({ ok: false, error: "Profile picture not found." });

        const photo = await getPhoto(storedPath);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Content-Type", photo.contentType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        photo.body.on("error", next);
        return photo.body.pipe(res);
    } catch (error) {
        if (error.code === "ENOENT" || error.name === "NoSuchKey" || error.name === "NotFound") {
            return res.status(404).json({ ok: false, error: "Profile picture file not found." });
        }
        return next(error);
    }
});

module.exports = router;
