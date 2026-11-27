ALTER TABLE barangays
    ADD COLUMN IF NOT EXISTS location geometry(Point, 4326);

ALTER TABLE announcements
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS barangays_name_lower_unique ON barangays (lower(name));

INSERT INTO feeders (name, substation_id)
SELECT 'Feeder C', (SELECT id FROM substations ORDER BY id LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM feeders WHERE name = 'Feeder C');

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0583, 13.7567), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder A' ORDER BY id LIMIT 1)
WHERE name = 'Poblacion';

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0638, 13.7810), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder A' ORDER BY id LIMIT 1)
WHERE name = 'Alangilan';

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0415, 13.7648), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder B' ORDER BY id LIMIT 1)
WHERE name = 'Pallocan West';

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0512, 13.7485), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder B' ORDER BY id LIMIT 1)
WHERE name = 'Kumintang Ibaba';

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0528, 13.7722), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder C' ORDER BY id LIMIT 1)
WHERE name = 'Bolbok';

UPDATE barangays
SET location = ST_SetSRID(ST_MakePoint(121.0690, 13.7460), 4326),
    feeder_id = (SELECT id FROM feeders WHERE name = 'Feeder C' ORDER BY id LIMIT 1)
WHERE name = 'Sta. Rita Karsada';

CREATE INDEX IF NOT EXISTS barangays_location_gist ON barangays USING gist (location);

WITH sample_nodes (node_name, barangay_name) AS (
    VALUES
        ('N-POBLACION', 'Poblacion'),
        ('N-ALANGILAN', 'Alangilan'),
        ('N-PALLOCAN-WEST', 'Pallocan West'),
        ('N-KUMINTANG-IBABA', 'Kumintang Ibaba'),
        ('N-BOLBOK', 'Bolbok'),
        ('N-STA-RITA-KARSADA', 'Sta. Rita Karsada')
)
INSERT INTO nodes (name, barangay_id, feeder_id)
SELECT sample_nodes.node_name, barangays.id, barangays.feeder_id
FROM sample_nodes
JOIN barangays ON barangays.name = sample_nodes.barangay_name
WHERE NOT EXISTS (
    SELECT 1 FROM nodes WHERE nodes.name = sample_nodes.node_name
);
