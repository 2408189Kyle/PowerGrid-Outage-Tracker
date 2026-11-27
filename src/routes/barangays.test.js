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
const barangays = require("./barangays");

const app = express();
app.use(express.json());
app.use("/api/barangays", barangays);

beforeEach(() => jest.clearAllMocks());

test("lists database barangays with numeric map coordinates", async () => {
    query.mockResolvedValue({
        rows: [{
            id: 4,
            name: "Pallocan West",
            latitude: "13.7648",
            longitude: "121.0415",
            feeder_id: "2",
            boundary_available: false
        }]
    });

    const response = await request(app).get("/api/barangays");

    expect(response.status).toBe(200);
    expect(response.body.barangays[0]).toMatchObject({
        id: 4,
        name: "Pallocan West",
        latitude: 13.7648,
        longitude: 121.0415,
        feeder_id: 2,
        boundary_available: false
    });
});

test("admin-created areas persist a point and feeder assignment", async () => {
    query.mockResolvedValue({
        rows: [{
            id: 9,
            name: "Demo Area",
            latitude: 13.75,
            longitude: 121.05,
            feeder_id: 3,
            boundary_available: false
        }]
    });

    const response = await request(app)
        .post("/api/barangays")
        .set("x-test-role", "admin")
        .send({ name: "Demo Area", latitude: "13.75", longitude: "121.05", feeder_id: "3" });

    expect(response.status).toBe(201);
    expect(query).toHaveBeenCalledWith(
        expect.stringContaining("ST_SetSRID(ST_MakePoint($3, $2), 4326)"),
        ["Demo Area", 13.75, 121.05, 3, 1000]
    );
});

test("residents cannot add barangays", async () => {
    const response = await request(app)
        .post("/api/barangays")
        .send({ name: "Demo Area", latitude: 13.75, longitude: 121.05, feeder_id: 1 });

    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
});
