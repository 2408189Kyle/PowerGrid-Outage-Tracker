"use strict";

require("dotenv").config();

const app = require("./app");
const { pool } = require("./config/db");
const { startHeartbeatConsumer } = require("./services/mqtt-heartbeat");

const port = Number(process.env.PORT) || 3002;

pool.query("SELECT 1")
    .then(() => {
        startHeartbeatConsumer();
        app.listen(port, () => {
            console.log(`PowerGrid server running at http://localhost:${port}`);
        });
    })
    .catch(async (error) => {
        console.error("Could not start PowerGrid server:", error.message);
        await pool.end();
        process.exitCode = 1;
    });
