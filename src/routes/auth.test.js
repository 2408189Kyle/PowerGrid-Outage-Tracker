"use strict";

jest.mock("../config/db", () => ({ query: jest.fn() }));
jest.mock("bcryptjs", () => ({
    compare: jest.fn(),
    hash: jest.fn(),
    hashSync: jest.fn(() => "dummy-hash")
}));
jest.mock("jsonwebtoken", () => ({ sign: jest.fn(() => "test-token") }));

const express = require("express");
const request = require("supertest");
const { query } = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const authRoutes = require("./auth");

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

beforeEach(() => {
    jest.clearAllMocks();
});

test("public registration always creates a resident, ignoring a submitted role", async () => {
    query
        .mockResolvedValueOnce({ rows: [{ id: 4, name: "Poblacion" }] })
        .mockResolvedValueOnce({
            rows: [{
                id: 15,
                name: "Resident User",
                email: "resident@example.com",
                role: "resident",
                barangay_id: 4
            }]
        });
    bcrypt.hash.mockResolvedValue("password-hash");

    const response = await request(app)
        .post("/api/auth/register")
        .send({
            name: "Resident User",
            email: "resident@example.com",
            barangay: "Poblacion",
            password: "passcode123",
            confirm: "passcode123",
            role: "admin"
        });

    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe("resident");
    expect(query.mock.calls[1][0]).toContain("VALUES ($1, $2, $3, $4, 'resident')");
    expect(jwt.sign).toHaveBeenCalled();
});

test.each([
    ["resident", "admin"],
    ["staff", "resident"]
])("rejects a %s portal login for a %s account", async (audience, role) => {
    query.mockResolvedValue({
        rows: [{
            id: 15,
            name: "PowerGrid User",
            email: "user@example.com",
            role,
            barangay_id: 4,
            password_hash: "password-hash",
            barangay: "Poblacion"
        }]
    });
    bcrypt.compare.mockResolvedValue(true);

    const response = await request(app)
        .post("/api/auth/login")
        .send({ email: "user@example.com", password: "passcode123", audience });

    expect(response.status).toBe(401);
    expect(response.body.ok).toBe(false);
    expect(jwt.sign).not.toHaveBeenCalled();
});

test("allows an admin account through the staff portal", async () => {
    query.mockResolvedValue({
        rows: [{
            id: 16,
            name: "PowerGrid Staff",
            email: "staff@example.com",
            role: "admin",
            barangay_id: 4,
            password_hash: "password-hash",
            barangay: "Poblacion"
        }]
    });
    bcrypt.compare.mockResolvedValue(true);

    const response = await request(app)
        .post("/api/auth/login")
        .send({ email: "staff@example.com", password: "passcode123", audience: "staff" });

    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("admin");
    expect(response.body.token).toBe("test-token");
    expect(jwt.sign).toHaveBeenCalled();
});

test("requires a sign-in audience", async () => {
    const response = await request(app)
        .post("/api/auth/login")
        .send({ email: "user@example.com", password: "passcode123" });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
});
