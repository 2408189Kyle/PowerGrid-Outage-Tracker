"use strict";

jest.mock("mqtt", () => ({ connect: jest.fn() }));
jest.mock("../config/db", () => ({ query: jest.fn() }));

const EventEmitter = require("events");
const mqtt = require("mqtt");
const { query } = require("../config/db");
const { handleHeartbeat, startHeartbeatConsumer } = require("./mqtt-heartbeat");

const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => {
    jest.clearAllMocks();
    process.env.MQTT_ENABLED = "true";
    process.env.MQTT_URL = "mqtt://localhost:1883";
    process.env.MQTT_TOPIC_PREFIX = "powergrid/nodes";
    process.env.HEARTBEAT_TIMEOUT_S = "15";
});

test("records a validated heartbeat for a registered node", async () => {
    query.mockResolvedValue({ rows: [{ node_id: 7 }] });

    const stored = await handleHeartbeat(
        "powergrid/nodes/N-POBLACION/heartbeat",
        Buffer.from(JSON.stringify({ seq: 42, latency_ms: 18, packet_loss_pct: 0 })),
        { prefix: "powergrid/nodes", queryFn: query, logger }
    );

    expect(stored).toBe(true);
    expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO heartbeats"),
        ["N-POBLACION", 18, 0, 42]
    );
});

test("ignores malformed payloads and unregistered nodes", async () => {
    const malformed = await handleHeartbeat(
        "powergrid/nodes/N-POBLACION/heartbeat",
        Buffer.from('{"seq":"bad"}'),
        { prefix: "powergrid/nodes", queryFn: query, logger }
    );
    expect(malformed).toBe(false);
    expect(query).not.toHaveBeenCalled();

    query.mockResolvedValue({ rows: [] });
    const unknownNode = await handleHeartbeat(
        "powergrid/nodes/NOT-REGISTERED/heartbeat",
        Buffer.from(JSON.stringify({ seq: 1, latency_ms: 10, packet_loss_pct: 0 })),
        { prefix: "powergrid/nodes", queryFn: query, logger }
    );
    expect(unknownNode).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unregistered node"));
});

test("subscribes only when explicitly enabled", () => {
    const client = new EventEmitter();
    client.subscribe = jest.fn((_topic, _options, callback) => callback(null));
    mqtt.connect.mockReturnValue(client);

    process.env.MQTT_ENABLED = "false";
    expect(startHeartbeatConsumer({ connect: mqtt.connect, queryFn: query, logger })).toBeNull();
    expect(mqtt.connect).not.toHaveBeenCalled();

    process.env.MQTT_ENABLED = "true";
    expect(startHeartbeatConsumer({ connect: mqtt.connect, queryFn: query, logger })).toBe(client);
    expect(mqtt.connect).toHaveBeenCalledWith("mqtt://localhost:1883", {
        reconnectPeriod: 2000,
        connectTimeout: 10000
    });
    client.emit("connect");
    expect(client.subscribe).toHaveBeenCalledWith(
        "powergrid/nodes/+/heartbeat",
        { qos: 1 },
        expect.any(Function)
    );
});
