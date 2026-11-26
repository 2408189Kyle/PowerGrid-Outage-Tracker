"use strict";

require("dotenv").config();

const bcrypt = require("bcryptjs");
const { pool } = require("../src/config/db");

const [rawEmail, password, name = "PowerGrid Staff"] = process.argv.slice(2);

async function createAdmin() {
    if (!rawEmail || !password) {
        throw new Error("Usage: node scripts/create-admin.js <email> <password> [name]");
    }

    const email = rawEmail.trim().toLowerCase();
    if (password.length < 8 || !/[0-9]/.test(password)) {
        throw new Error("Password must be at least 8 characters and contain a number.");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             password_hash = EXCLUDED.password_hash,
             role = 'admin',
             is_active = true`,
        [name.trim(), email, passwordHash]
    );
    console.log(`Admin account ready: ${email}`);
}

createAdmin()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
