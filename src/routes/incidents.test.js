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

jest.mock("../services/photo-storage", () => ({
    getPhoto: jest.fn(),
    isValidImageSignature: jest.fn((buffer, mimetype) => {
        if (mimetype === "image/jpeg") {
            return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
        }
        return mimetype === "image/png" &&
            buffer.length >= 8 &&
            buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }),
    removePhoto: jest.fn().mockResolvedValue(),
    storePhoto: jest.fn().mockResolvedValue("minio:0123456789abcdef0123456789abcdef.png")
}));

const express = require("express");
const request = require("supertest");
const { Readable } = require("stream");
const { pool, query } = require("../config/db");
const { getPhoto, removePhoto, storePhoto } = require("../services/photo-storage");
const incidents = require("./incidents");

const app = express();
app.use(express.json());
app.use("/api/incidents", incidents);

function mockTransaction(responses) {
    const client = {
        query: jest.fn()
            .mockImplementationOnce(async () => ({ rows: [] }))
            .mockImplementation(async () => responses.shift()),
        release: jest.fn()
    };
    pool.connect.mockResolvedValue(client);
    return client;
}

beforeEach(() => {
    jest.clearAllMocks();
});

test("lists incidents using UI status and numeric coordinates", async () => {
    query.mockResolvedValue({
        rows: [{
            id: 8,
            status: "Under Repair",
            latitude: "13.75",
            longitude: "121.05",
            barangay: "Poblacion"
        }]
    });

    const response = await request(app).get("/api/incidents");

    expect(response.status).toBe(200);
    expect(response.body.incidents[0]).toMatchObject({
        id: 8,
        ui_status: "repair",
        latitude: 13.75,
        longitude: 121.05,
        barangay: "Poblacion"
    });
});

test("rejects malformed resident reports before opening a database transaction", async () => {
    const response = await request(app)
        .post("/api/incidents/reports")
        .send({ barangay: "Poblacion", latitude: 200, longitude: 121 });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
});

test("creates a persisted incident and report in one transaction", async () => {
    const reportRow = { id: 41, incident_id: 23, landmark: "Main Road" };
    const client = mockTransaction([
        { rows: [{ id: 2, name: "Poblacion" }] },
        { rows: [] },
        { rows: [{ id: 23 }] },
        { rows: [reportRow] },
        { rows: [] }
    ]);

    const response = await request(app)
        .post("/api/incidents/reports")
        .send({
            barangay: "Poblacion",
            landmark: "Main Road",
            cause: "Power line fault",
            latitude: 13.7567,
            longitude: 121.0583,
            households: 12,
            notes: "Transformer is sparking"
        });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, incident_id: 23, report: reportRow });
    expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO incidents"),
        expect.arrayContaining([2, 121.0583, 13.7567, "Power line fault", 12])
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
});

test("groups nearby reports and accumulates affected households", async () => {
    const client = mockTransaction([
        { rows: [{ id: 2, name: "Poblacion" }] },
        { rows: [{ id: 23, report_count: 1, est_households: 12 }] },
        { rows: [] },
        { rows: [{ id: 42, incident_id: 23 }] },
        { rows: [] }
    ]);

    const response = await request(app)
        .post("/api/incidents/reports")
        .send({
            barangay: "Poblacion",
            landmark: "Nearby street",
            latitude: 13.7567,
            longitude: 121.0583,
            households: 5
        });

    expect(response.status).toBe(201);
    expect(response.body.incident_id).toBe(23);
    expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("est_households = est_households + $2"),
        [23, 5]
    );
    expect(client.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO incidents"))).toBe(false);
});

test("stores an uploaded PNG using the configured photo storage provider", async () => {
    const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00
    ]);
    const client = mockTransaction([
        { rows: [{ id: 2, name: "Poblacion" }] },
        { rows: [] },
        { rows: [{ id: 23 }] },
        { rows: [{ id: 42, incident_id: 23 }] },
        { rows: [] }
    ]);
    const response = await request(app)
        .post("/api/incidents/reports")
        .field("barangay", "Poblacion")
        .field("landmark", "Photo test")
        .field("latitude", "13.7567")
        .field("longitude", "121.0583")
        .field("households", "4")
        .attach("photo", png, { filename: "report.png", contentType: "image/png" });

    expect(response.status).toBe(201);
    const insert = client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO reports"));
    expect(insert).toBeDefined();
    expect(insert[1][8]).toBe("minio:0123456789abcdef0123456789abcdef.png");
    expect(storePhoto).toHaveBeenCalledWith(expect.any(Buffer), "image/png");
});

test("rejects unsupported photo types before opening a database transaction", async () => {
    const response = await request(app)
        .post("/api/incidents/reports")
        .field("barangay", "Poblacion")
        .attach("photo", Buffer.from("not an image"), { filename: "report.gif", contentType: "image/gif" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Upload a JPG or PNG image.");
    expect(pool.connect).not.toHaveBeenCalled();
});

test("rejects files whose contents do not match their declared image type", async () => {
    const response = await request(app)
        .post("/api/incidents/reports")
        .field("barangay", "Poblacion")
        .field("latitude", "13.7567")
        .field("longitude", "121.0583")
        .attach("photo", Buffer.from("not actually a png"), {
            filename: "fake.png",
            contentType: "image/png"
        });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("The uploaded file is not a valid JPG or PNG image.");
    expect(pool.connect).not.toHaveBeenCalled();
});

test("enforces the server-side photo size limit", async () => {
    const response = await request(app)
        .post("/api/incidents/reports")
        .field("barangay", "Poblacion")
        .attach("photo", Buffer.alloc(8 * 1024 * 1024 + 1), {
            filename: "too-large.jpg",
            contentType: "image/jpeg"
        });

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("Photo must be 8 MB or smaller.");
    expect(pool.connect).not.toHaveBeenCalled();
});

test("serves stored photos using the authenticated incident photo route", async () => {
    const contents = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const key = "minio:0123456789abcdef0123456789abcdef.png";
    query.mockResolvedValue({ rows: [{ photo_path: key }] });
    getPhoto.mockResolvedValue({ body: Readable.from([contents]), contentType: "image/png" });

    const response = await request(app).get("/api/incidents/23/photo");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.body).toEqual(contents);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(getPhoto).toHaveBeenCalledWith(key);
});

test("removes stored object photos when an admin deletes an incident", async () => {
    const key = "minio:0123456789abcdef0123456789abcdef.png";
    mockTransaction([
        { rows: [{ id: 23 }] },
        { rows: [{ photo_path: key }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
        { rows: [] }
    ]);

    const response = await request(app)
        .delete("/api/incidents/23")
        .set("x-test-role", "admin");

    expect(response.status).toBe(200);
    expect(removePhoto).toHaveBeenCalledWith(key);
});

test("prevents residents from changing incident status", async () => {
    const response = await request(app)
        .patch("/api/incidents/23/status")
        .send({ status: "Verified" });

    expect(response.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
});

test("records an admin status change and update history transactionally", async () => {
    const client = mockTransaction([
        { rows: [{ status: "Reported" }] },
        { rows: [] },
        { rows: [] },
        { rows: [] }
    ]);

    const response = await request(app)
        .patch("/api/incidents/23/status")
        .set("x-test-role", "admin")
        .send({ status: "Verified", note: "Confirmed by staff" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, incident_id: 23, status: "Verified" });
    expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO incident_updates"),
        ["23", "12", "Reported", "Verified", "Confirmed by staff"]
    );
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
});
