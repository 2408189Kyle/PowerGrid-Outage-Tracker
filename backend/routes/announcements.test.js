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
const announcements = require("./announcements");

const app = express();
app.use(express.json());
app.use("/api/announcements", announcements);

beforeEach(() => jest.clearAllMocks());

test("creates an announcement in the database with its staff creator", async () => {
    const announcement = { id: 5, title: "Weather advisory", body: "Heavy rain expected.", type: "advisory" };
    query.mockResolvedValue({ rows: [announcement] });

    const response = await request(app)
        .post("/api/announcements")
        .set("x-test-role", "admin")
        .send({ title: "Weather advisory", body: "Heavy rain expected.", type: "advisory" });

    expect(response.status).toBe(201);
    expect(response.body.announcement).toMatchObject(announcement);
    expect(query.mock.calls[0][1]).toEqual(["Weather advisory", "Heavy rain expected.", "advisory", null, null, null, "12"]);
});

test("edits announcement text through the persisted API", async () => {
    query.mockResolvedValue({ rows: [{ id: 5, body: "Updated notice" }] });

    const response = await request(app)
        .patch("/api/announcements/5")
        .set("x-test-role", "admin")
        .send({ body: "Updated notice" });

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE announcements SET body = $2"),
        [5, "Updated notice"]
    );
});

test("rejects general announcement types that the database does not support", async () => {
    const response = await request(app)
        .post("/api/announcements")
        .set("x-test-role", "admin")
        .send({ title: "Notice", body: "Hello", type: "general" });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
});
