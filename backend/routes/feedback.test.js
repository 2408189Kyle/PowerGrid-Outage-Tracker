"use strict";

jest.mock("../config/db", () => ({ query: jest.fn() }));
jest.mock("../middleware/auth", () => (req, _res, next) => {
    req.user = { sub: "12", role: req.get("x-test-role") || "resident" };
    next();
});
jest.mock("../middleware/admin", () => (req, res, next) => {
    if (req.user && req.user.role === "admin") return next();
    return res.status(403).json({ ok: false, error: "Administrator access required." });
});

const express = require("express");
const request = require("supertest");
const { query } = require("../config/db");
const feedback = require("./feedback");

const app = express();
app.use(express.json());
app.use("/api/feedback", feedback);

beforeEach(() => jest.clearAllMocks());

test("persists feedback with the authenticated account name", async () => {
    query
        .mockResolvedValueOnce({ rows: [{ id: 4 }] })
        .mockResolvedValueOnce({ rows: [{ name: "Resident" }] })
        .mockResolvedValueOnce({ rows: [{ id: 9, comment: "Power is out." }] });

    const response = await request(app)
        .post("/api/feedback")
        .send({ barangay: "Poblacion", location: "Main Road", comment: "Power is out." });

    expect(response.status).toBe(201);
    expect(query).toHaveBeenLastCalledWith(
        expect.stringContaining("INSERT INTO community_feedback"),
        [4, "Main Road", "Power is out.", "Resident"]
    );
});

test("serves shared feedback and restricts clearing it to administrators", async () => {
    query.mockResolvedValue({ rows: [] });

    const list = await request(app).get("/api/feedback");
    const clear = await request(app).delete("/api/feedback");
    const adminClear = await request(app).delete("/api/feedback").set("x-test-role", "admin");

    expect(list.status).toBe(200);
    expect(clear.status).toBe(403);
    expect(adminClear.status).toBe(200);
    expect(query).toHaveBeenCalledWith("DELETE FROM community_feedback");
});
