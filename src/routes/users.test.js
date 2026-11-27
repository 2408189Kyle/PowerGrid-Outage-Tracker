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
const { pool } = require("../config/db");
const users = require("./users");

const app = express();
app.use(express.json());
app.use("/api/users", users);

beforeEach(() => jest.clearAllMocks());

test("prevents administrators from changing their own role", async () => {
    const response = await request(app)
        .patch("/api/users/12")
        .set("x-test-role", "admin")
        .send({ role: "resident" });

    expect(response.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
});

test("prevents deactivation of the last active administrator", async () => {
    const client = {
        query: jest.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 13, role: "admin", is_active: true }] })
            .mockResolvedValueOnce({ rows: [{ active_admins: 1 }] })
            .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
        .patch("/api/users/13")
        .set("x-test-role", "admin")
        .send({ is_active: false });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("last active administrator");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
});

test("updates account profile and normalizes email transactionally", async () => {
    const updatedUser = { id: 13, name: "Resident Updated", email: "resident@example.com", role: "resident", is_active: true };
    const client = {
        query: jest.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 13, role: "resident", is_active: true }] })
            .mockResolvedValueOnce({ rows: [updatedUser] })
            .mockResolvedValueOnce({ rows: [] }),
        release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);

    const response = await request(app)
        .patch("/api/users/13")
        .set("x-test-role", "admin")
        .send({ name: "Resident Updated", email: "Resident@Example.com" });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject(updatedUser);
    expect(client.query.mock.calls[3][1]).toEqual([13, "Resident Updated", "resident@example.com", undefined, undefined]);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
});
