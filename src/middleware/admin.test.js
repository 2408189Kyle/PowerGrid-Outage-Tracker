"use strict";

jest.mock("../config/db", () => ({ query: jest.fn() }));

const express = require("express");
const request = require("supertest");
const { query } = require("../config/db");
const requireAdmin = require("./admin");

const app = express();
app.use((req, _res, next) => {
    req.user = { sub: "12", role: req.get("x-token-role") || "resident" };
    next();
});
app.get("/admin", requireAdmin, (_req, res) => res.sendStatus(204));

beforeEach(() => jest.clearAllMocks());

test("uses current database role instead of a potentially stale token role", async () => {
    query.mockResolvedValue({ rows: [{ role: "resident", is_active: true }] });

    const response = await request(app).get("/admin").set("x-token-role", "admin");

    expect(response.status).toBe(403);
});

test("rejects deactivated accounts even while their token is otherwise valid", async () => {
    query.mockResolvedValue({ rows: [{ role: "admin", is_active: false }] });

    const response = await request(app).get("/admin").set("x-token-role", "admin");

    expect(response.status).toBe(401);
});
