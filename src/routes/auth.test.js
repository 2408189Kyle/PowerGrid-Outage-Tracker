"use strict";

jest.mock("../config/db", () => ({ query: jest.fn() }));
jest.mock("bcryptjs", () => ({
    compare: jest.fn(),
    hash: jest.fn(),
    hashSync: jest.fn(() => "dummy-hash")
}));
jest.mock("jsonwebtoken", () => ({ sign: jest.fn(() => "test-token") }));
jest.mock("../middleware/auth", () => (req, _res, next) => {
    req.user = { sub: "15", role: "resident" };
    next();
});
jest.mock("../services/photo-storage", () => ({
    getPhoto: jest.fn(),
    isValidImageSignature: jest.fn(),
    removePhoto: jest.fn().mockResolvedValue(),
    storePhoto: jest.fn().mockResolvedValue("minio:0123456789abcdef0123456789abcdef.jpg")
}));

const express = require("express");
const request = require("supertest");
const { Readable } = require("stream");
const { query } = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getPhoto, isValidImageSignature, storePhoto } = require("../services/photo-storage");
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

test("lets a signed-in user update their name and profile picture", async () => {
    query
        .mockResolvedValueOnce({ rows: [{ profile_photo_path: null, barangay: "Poblacion" }] })
        .mockResolvedValueOnce({
            rows: [{
                id: 15,
                name: "Updated Resident",
                email: "resident@example.com",
                role: "resident",
                barangay_id: 4,
                profile_photo_path: "minio:0123456789abcdef0123456789abcdef.jpg"
            }]
        });
    isValidImageSignature.mockReturnValue(true);

    const response = await request(app)
        .patch("/api/auth/me")
        .field("name", "Updated Resident")
        .attach("photo", Buffer.from([0xff, 0xd8, 0xff, 0x00]), {
            filename: "avatar.jpg",
            contentType: "image/jpeg"
        });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
        name: "Updated Resident",
        barangay: "Poblacion",
        profile_photo_url: "/api/auth/me/photo"
    });
    expect(storePhoto).toHaveBeenCalledWith(
        Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        "image/jpeg"
    );
    expect(query.mock.calls[1][1]).toEqual([
        "15",
        "Updated Resident",
        "minio:0123456789abcdef0123456789abcdef.jpg"
    ]);
});

test("keeps the existing profile picture when only the name is changed", async () => {
    const storedPath = "minio:0123456789abcdef0123456789abcdef.jpg";
    query
        .mockResolvedValueOnce({ rows: [{ profile_photo_path: storedPath, barangay: "Poblacion" }] })
        .mockResolvedValueOnce({
            rows: [{
                id: 15,
                name: "Resident Renamed",
                email: "resident@example.com",
                role: "resident",
                barangay_id: 4,
                profile_photo_path: storedPath
            }]
        });

    const response = await request(app)
        .patch("/api/auth/me")
        .field("name", "Resident Renamed");

    expect(response.status).toBe(200);
    expect(response.body.user.profile_photo_url).toBe("/api/auth/me/photo");
    expect(query.mock.calls[1][1]).toEqual(["15", "Resident Renamed", null]);
    expect(storePhoto).not.toHaveBeenCalled();
});

test("rejects profile photo uploads whose contents do not match the image type", async () => {
    isValidImageSignature.mockReturnValue(false);

    const response = await request(app)
        .patch("/api/auth/me")
        .field("name", "Resident User")
        .attach("photo", Buffer.from("not an image"), {
            filename: "avatar.jpg",
            contentType: "image/jpeg"
        });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("not a valid JPG or PNG");
    expect(query).not.toHaveBeenCalled();
    expect(storePhoto).not.toHaveBeenCalled();
});

test("serves the signed-in user's stored profile picture", async () => {
    query.mockResolvedValueOnce({
        rows: [{ profile_photo_path: "minio:0123456789abcdef0123456789abcdef.jpg" }]
    });
    getPhoto.mockResolvedValueOnce({
        body: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]),
        contentType: "image/jpeg"
    });

    const response = await request(app).get("/api/auth/me/photo");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-type"]).toContain("image/jpeg");
});
