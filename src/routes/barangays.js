"use strict";

const express = require("express");
const { query } = require("../config/db");

const router = express.Router();

router.get("/", async (_req, res, next) => {
    try {
        const result = await query("SELECT id, name FROM barangays ORDER BY name");
        return res.json({ ok: true, barangays: result.rows });
    } catch (error) {
        return next(error);
    }
});

module.exports = router;
