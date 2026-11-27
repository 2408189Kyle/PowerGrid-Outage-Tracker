CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE substations (
    id serial PRIMARY KEY,
    name text NOT NULL,
    location geometry(Point, 4326)
);

CREATE TABLE feeders (
    id serial PRIMARY KEY,
    name text NOT NULL,
    substation_id int NOT NULL REFERENCES substations(id)
);

CREATE TABLE barangays (
    id serial PRIMARY KEY,
    name text UNIQUE NOT NULL,
    boundary geometry(Geometry, 4326),
    location geometry(Point, 4326),
    households_estimate int NOT NULL DEFAULT 1000,
    feeder_id int REFERENCES feeders(id)
);

CREATE TABLE users (
    id serial PRIMARY KEY,
    name text NOT NULL,
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'resident' CHECK (role IN ('resident', 'admin')),
    barangay_id int REFERENCES barangays(id),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nodes (
    id serial PRIMARY KEY,
    name text UNIQUE NOT NULL,
    barangay_id int REFERENCES barangays(id),
    feeder_id int REFERENCES feeders(id),
    status text NOT NULL DEFAULT 'up' CHECK (status IN ('up', 'down')),
    last_heartbeat_at timestamptz,
    latency_ms int,
    packet_loss_pct numeric DEFAULT 0
);

CREATE TABLE incidents (
    id serial PRIMARY KEY,
    barangay_id int NOT NULL REFERENCES barangays(id),
    center geometry(Point, 4326) NOT NULL,
    status text NOT NULL DEFAULT 'Reported'
        CHECK (status IN ('Reported', 'Verified', 'Under Repair', 'Restored')),
    source text NOT NULL DEFAULT 'community'
        CHECK (source IN ('community', 'system')),
    cause text,
    started_at timestamptz NOT NULL,
    verified_at timestamptz,
    restored_at timestamptz,
    report_count int NOT NULL DEFAULT 0,
    est_households int NOT NULL DEFAULT 0,
    predicted_restore_at timestamptz,
    predicted_duration_min int,
    node_id int REFERENCES nodes(id)
);

CREATE TABLE reports (
    id serial PRIMARY KEY,
    user_id int NOT NULL REFERENCES users(id),
    incident_id int REFERENCES incidents(id),
    barangay_id int NOT NULL REFERENCES barangays(id),
    landmark text,
    location geometry(Point, 4326) NOT NULL,
    started_at timestamptz NOT NULL,
    notes text,
    photo_path text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incident_updates (
    id serial PRIMARY KEY,
    incident_id int NOT NULL REFERENCES incidents(id),
    admin_id int REFERENCES users(id),
    old_status text,
    new_status text,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
    id serial PRIMARY KEY,
    title text NOT NULL,
    body text NOT NULL,
    type text NOT NULL CHECK (type IN ('maintenance', 'advisory')),
    barangay_id int REFERENCES barangays(id),
    starts_at timestamptz,
    ends_at timestamptz,
    created_by int REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE heartbeats (
    id bigserial PRIMARY KEY,
    node_id int NOT NULL REFERENCES nodes(id),
    received_at timestamptz NOT NULL DEFAULT now(),
    latency_ms int,
    seq bigint
);

CREATE TABLE weather_advisories (
    id serial PRIMARY KEY,
    signal_level int,
    area text,
    starts_at timestamptz,
    ends_at timestamptz
);

CREATE INDEX reports_location_gist ON reports USING gist (location);
CREATE INDEX incidents_center_gist ON incidents USING gist (center);
CREATE INDEX barangays_boundary_gist ON barangays USING gist (boundary);
CREATE INDEX incidents_barangay_status_started
    ON incidents (barangay_id, status, started_at);
CREATE INDEX nodes_last_heartbeat ON nodes (last_heartbeat_at);
