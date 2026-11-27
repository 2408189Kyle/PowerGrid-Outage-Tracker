"use strict";

jest.mock("../config/db", () => ({ query: jest.fn() }));

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { query } = require("../config/db");

process.env.JWT_SECRET = "test-jwt-secret-with-at-least-thirty-two-characters";
const requireAuth = require("./auth");
const app = express();
app.get("/protected", requireAuth, (req, res) => res.json({ user: req.user }));

beforeEach(() => jest.clearAllMocks());

test("rejects a valid token when the account has been deactivated", async () => {
    query.mockResolvedValue({ rows: [{ role: "resident", is_active: false }] });
    const token = jwt.sign({ sub: "12", role: "resident" }, process.env.JWT_SECRET);

    const response = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Account is unavailable.");
});

test("uses the current database role for an authenticated request", async () => {
    query.mockResolvedValue({ rows: [{ role: "admin", is_active: true }] });
    const token = jwt.sign({ sub: "12", role: "resident" }, process.env.JWT_SECRET);

    const response = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("admin");
});
