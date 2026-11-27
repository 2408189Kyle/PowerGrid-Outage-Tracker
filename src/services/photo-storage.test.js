"use strict";

const mockClients = [];

jest.mock("@aws-sdk/client-s3", () => {
    class S3Client {
        constructor() {
            this.send = jest.fn();
            mockClients.push(this);
        }
    }
    class Command {
        constructor(input) {
            this.input = input;
        }
    }
    class HeadBucketCommand extends Command {}
    class CreateBucketCommand extends Command {}
    class PutObjectCommand extends Command {}
    class GetObjectCommand extends Command {}
    class DeleteObjectCommand extends Command {}
    return {
        S3Client,
        HeadBucketCommand,
        CreateBucketCommand,
        PutObjectCommand,
        GetObjectCommand,
        DeleteObjectCommand
    };
});

process.env.PHOTO_STORAGE = "minio";

const {
    CreateBucketCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand
} = require("@aws-sdk/client-s3");
const { getPhoto, removePhoto, storePhoto } = require("./photo-storage");

beforeEach(() => {
    mockClients[0].send.mockReset().mockResolvedValue({});
});

test("creates the bucket if needed and uploads photos with a provider-qualified key", async () => {
    const contents = Buffer.from("image-data");
    const client = mockClients[0];
    client.send
        .mockRejectedValueOnce(Object.assign(new Error("not found"), { name: "NotFound" }))
        .mockResolvedValue({});

    const key = await storePhoto(contents, "image/png");

    expect(key).toMatch(/^minio:[a-f0-9]{32}\.png$/);
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(client.send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
    expect(client.send.mock.calls[2][0]).toBeInstanceOf(PutObjectCommand);
    expect(client.send.mock.calls[2][0].input).toMatchObject({
        Bucket: "powergrid-report-photos",
        Body: contents,
        ContentType: "image/png"
    });
});

test("reads and removes MinIO objects using validated keys", async () => {
    const client = mockClients[0];
    client.send.mockResolvedValue({ Body: "image-stream", ContentType: "image/jpeg" });
    const key = "minio:0123456789abcdef0123456789abcdef.jpg";

    const photo = await getPhoto(key);
    await removePhoto(key);

    expect(photo).toEqual({ body: "image-stream", contentType: "image/jpeg" });
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(client.send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(client.send.mock.calls[0][0].input.Key).toBe("0123456789abcdef0123456789abcdef.jpg");
    expect(client.send.mock.calls[1][0].input.Key).toBe("0123456789abcdef0123456789abcdef.jpg");
});

test("rejects malformed or path-traversing photo keys before storage access", async () => {
    await expect(getPhoto("../outside.png")).rejects.toThrow("Invalid stored photo key.");
    await expect(removePhoto("minio:../outside.png")).rejects.toThrow("Invalid stored photo key.");
    expect(mockClients[0].send).not.toHaveBeenCalled();
});
