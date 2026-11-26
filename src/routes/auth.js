"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { query } = require("../config/db");
const requireAuth = require("../middleware/auth");

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

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
    remember: z.boolean().optional()
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
        barangay
    };
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
            `INSERT INTO users (name, email, password_hash, barangay_id)
             VALUES ($1, $2, $3, $4)
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

        if (!record || !passwordMatches) {
            return res.status(401).json({ ok: false, error: "Email or password is incorrect." });
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
            `SELECT u.id, u.name, u.email, u.role, u.barangay_id, b.name AS barangay
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

module.exports = router;
