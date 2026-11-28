"use strict";

jest.mock("../config/db", () => ({
    pool: { connect: jest.fn() },
    query: jest.fn()
}));

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
const { pool, query } = require("../config/db");
const network = require("./network");

const app = express();
app.use(express.json());
app.use("/api/network", network);

function mockTransaction(responses) {
    const client = {
        query: jest.fn().mockImplementation(async (sql) => {
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
            return responses.shift();
        }),
        release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);
    return client;
}

beforeEach(() => {
    jest.clearAllMocks();
});

test("lists the persisted simulated state for each feeder", async () => {
    query.mockResolvedValue({
        rows: [
            { id: 1, name: "Feeder A", online: false },
            { id: 2, name: "Feeder B", online: true }
        ]
    });

    const response = await request(app).get("/api/network/feeders");

    expect(response.status).toBe(200);
    expect(response.body.feeders).toEqual([
        { id: 1, name: "Feeder A", online: false },
        { id: 2, name: "Feeder B", online: true }
    ]);
});

test("admin feeder cuts create shared system outages for assigned barangays", async () => {
    const client = mockTransaction([
        { rows: [{ id: 2 }] },
        { rows: [{ name: "Alangilan" }, { name: "Poblacion" }] },
        { rows: [] }
    ]);

    const response = await request(app)
        .patch("/api/network/feeders/2")
        .set("x-test-role", "admin")
        .send({ online: false });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
        ok: true,
        feeder: { id: 2, online: false },
        affected_barangays: ["Alangilan", "Poblacion"]
    });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO incidents"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
});

test("restoring a feeder closes its active simulated outages", async () => {
    const client = mockTransaction([
        { rows: [{ id: 2 }] },
        { rows: [{ name: "Alangilan" }] },
        { rows: [] }
    ]);

    const response = await request(app)
        .patch("/api/network/feeders/2")
        .set("x-test-role", "admin")
        .send({ online: true });

    expect(response.status).toBe(200);
    expect(response.body.feeder).toEqual({ id: 2, online: true });
    expect(client.query.mock.calls.some(([sql]) => sql.includes("UPDATE incidents"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
});

test("residents cannot change feeder simulation state", async () => {
    const response = await request(app)
        .patch("/api/network/feeders/2")
        .send({ online: false });

    expect(response.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
});
