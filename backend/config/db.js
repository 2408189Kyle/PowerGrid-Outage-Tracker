"use strict";

require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: process.env.VERCEL ? 2 : 10
});

pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL pool error:", error.message);
});

module.exports = {
    pool,
    query: (text, params) => pool.query(text, params)
};
