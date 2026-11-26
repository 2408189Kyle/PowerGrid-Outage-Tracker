"use strict";

require("dotenv").config();

const app = require("./app");
const { pool } = require("./config/db");

const port = Number(process.env.PORT) || 3002;

pool.query("SELECT 1")
    .then(() => {
        app.listen(port, () => {
            console.log(`PowerGrid server running at http://localhost:${port}`);
        });
    })
    .catch(async (error) => {
        console.error("Could not connect to PostgreSQL:", error.message);
        await pool.end();
        process.exitCode = 1;
    });
