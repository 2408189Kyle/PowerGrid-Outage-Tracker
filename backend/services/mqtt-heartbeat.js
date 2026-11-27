"use strict";

const mqtt = require("mqtt");
const { z } = require("zod");
const { query } = require("../config/db");

const heartbeatSchema = z.object({
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    latency_ms: z.number().int().min(0).max(60000),
    packet_loss_pct: z.number().min(0).max(100)
}).strict();

function parseTopic(topic, prefix) {
    const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/heartbeat$`).exec(topic);
    return match && /^[A-Za-z0-9_-]{1,80}$/.test(match[1]) ? match[1] : null;
}

async function handleHeartbeat(topic, payload, { prefix, queryFn = query, logger = console }) {
    const nodeName = parseTopic(topic, prefix);
    if (!nodeName) {
        logger.warn(`Ignoring MQTT message with unexpected topic: ${topic}`);
        return false;
    }
    if (payload.length > 1024) {
        logger.warn(`Ignoring oversized MQTT heartbeat for ${nodeName}.`);
        return false;
    }

    let data;
    try {
        data = heartbeatSchema.parse(JSON.parse(payload.toString("utf8")));
    } catch {
        logger.warn(`Ignoring invalid MQTT heartbeat for ${nodeName}.`);
        return false;
    }

    const result = await queryFn(
        `WITH updated AS (
             UPDATE nodes
             SET status = 'up', last_heartbeat_at = now(), latency_ms = $2, packet_loss_pct = $3
             WHERE name = $1
             RETURNING id
         )
         INSERT INTO heartbeats (node_id, latency_ms, seq)
         SELECT id, $2, $4 FROM updated
         RETURNING node_id`,
        [nodeName, data.latency_ms, data.packet_loss_pct, data.seq]
    );
    if (!result.rows[0]) {
        logger.warn(`Ignoring MQTT heartbeat from unregistered node ${nodeName}.`);
        return false;
    }
    return true;
}

function startHeartbeatConsumer(options = {}) {
    if (process.env.MQTT_ENABLED !== "true") {
        console.log("MQTT heartbeat adapter disabled; set MQTT_ENABLED=true to connect.");
        return null;
    }

    const url = process.env.MQTT_URL;
    if (!url) throw new Error("MQTT_URL is required when MQTT_ENABLED=true.");
    const prefix = (process.env.MQTT_TOPIC_PREFIX || "powergrid/nodes").replace(/^\/+|\/+$/g, "");
    if (!prefix || !/^[A-Za-z0-9_/-]+$/.test(prefix)) {
        throw new Error("MQTT_TOPIC_PREFIX contains unsupported characters.");
    }
    const timeoutSeconds = Number(process.env.HEARTBEAT_TIMEOUT_S || 15);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 3600) {
        throw new Error("HEARTBEAT_TIMEOUT_S must be an integer from 5 to 3600.");
    }

    const connect = options.connect || mqtt.connect;
    const queryFn = options.queryFn || query;
    const logger = options.logger || console;
    const client = connect(url, { reconnectPeriod: 2000, connectTimeout: 10000 });

    client.on("connect", () => {
        client.subscribe(`${prefix}/+/heartbeat`, { qos: 1 }, (error) => {
            if (error) logger.error("Could not subscribe to MQTT heartbeats:", error.message);
            else logger.log(`MQTT heartbeat adapter subscribed to ${prefix}/+/heartbeat.`);
        });
    });
    client.on("message", (topic, payload) => {
        handleHeartbeat(topic, payload, { prefix, queryFn, logger })
            .catch((error) => logger.error(`Could not process MQTT heartbeat ${topic}:`, error.message));
    });
    client.on("error", (error) => logger.error("MQTT connection error:", error.message));

    const staleTimer = setInterval(() => {
        queryFn(
            `UPDATE nodes
             SET status = 'down'
             WHERE status = 'up' AND last_heartbeat_at IS NOT NULL
               AND last_heartbeat_at < now() - ($1 * interval '1 second')`,
            [timeoutSeconds]
        ).catch((error) => logger.error("Could not mark stale MQTT nodes offline:", error.message));
    }, Math.min(timeoutSeconds * 1000, 60000));
    staleTimer.unref();
    return client;
}

module.exports = { handleHeartbeat, startHeartbeatConsumer };
