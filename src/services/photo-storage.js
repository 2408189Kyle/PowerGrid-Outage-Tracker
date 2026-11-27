"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const photoDirectory = path.resolve(__dirname, "..", "..", "storage", "report-photos");
const photoKeyPattern = /^[a-f0-9]{32}\.(?:jpg|png)$/;
const mode = process.env.PHOTO_STORAGE || "minio";
const bucket = process.env.S3_BUCKET || "powergrid-report-photos";
let client;

if (!["minio", "local"].includes(mode)) {
    throw new Error("PHOTO_STORAGE must be either minio or local.");
}

function getClient() {
    if (client) return client;
    const development = process.env.NODE_ENV !== "production";
    const endpoint = process.env.S3_ENDPOINT || (development ? "http://127.0.0.1:9000" : "");
    const accessKeyId = process.env.S3_ACCESS_KEY || (development ? "powergrid-dev" : "");
    const secretAccessKey = process.env.S3_SECRET_KEY || (development ? "powergrid-dev-secret" : "");
    if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new Error("S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY are required for MinIO photo storage.");
    }

    client = new S3Client({
        endpoint,
        region: process.env.S3_REGION || "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey }
    });
    return client;
}

if (mode === "minio") getClient();

async function ensureBucket(s3) {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
        const missing = error.name === "NotFound" ||
            error.name === "NoSuchBucket" ||
            error.$metadata && error.$metadata.httpStatusCode === 404;
        if (!missing) throw error;
        try {
            await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        } catch (createError) {
            if (createError.name !== "BucketAlreadyOwnedByYou") throw createError;
        }
    }
}

function parseStoredKey(storedKey) {
    if (typeof storedKey !== "string") throw new Error("Invalid stored photo key.");
    const separator = storedKey.indexOf(":");
    const provider = separator === -1 ? "legacy" : storedKey.slice(0, separator);
    const key = separator === -1 ? storedKey : storedKey.slice(separator + 1);
    if (!photoKeyPattern.test(key) || !["legacy", "local", "minio"].includes(provider)) {
        throw new Error("Invalid stored photo key.");
    }
    return { provider, key };
}

function contentTypeFor(key) {
    return key.endsWith(".png") ? "image/png" : "image/jpeg";
}

function isValidImageSignature(buffer, contentType) {
    if (contentType === "image/jpeg") {
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    return contentType === "image/png" &&
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function storePhoto(contents, contentType) {
    const extension = contentType === "image/png" ? ".png" : ".jpg";
    const key = `${crypto.randomBytes(16).toString("hex")}${extension}`;
    if (mode === "local") {
        await fs.promises.mkdir(photoDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(photoDirectory, key), contents, { flag: "wx" });
        return `local:${key}`;
    }

    const s3 = getClient();
    await ensureBucket(s3);
    await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: contents,
        ContentType: contentType
    }));
    return `minio:${key}`;
}

async function getPhoto(storedKey) {
    const { provider, key } = parseStoredKey(storedKey);
    if (provider === "legacy" || provider === "local") {
        const filePath = path.join(photoDirectory, key);
        await fs.promises.access(filePath);
        return {
            body: fs.createReadStream(filePath),
            contentType: contentTypeFor(key)
        };
    }

    const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { body: result.Body, contentType: result.ContentType || contentTypeFor(key) };
}

async function removePhoto(storedKey) {
    if (!storedKey) return;
    const { provider, key } = parseStoredKey(storedKey);
    if (provider === "legacy" || provider === "local") {
        try {
            await fs.promises.unlink(path.join(photoDirectory, key));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        return;
    }
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { getPhoto, isValidImageSignature, removePhoto, storePhoto };
