INSERT INTO substations (name) VALUES ('Substation 1');

INSERT INTO feeders (name, substation_id)
VALUES ('Feeder A', 1), ('Feeder B', 1);

INSERT INTO barangays (name, boundary, households_estimate, feeder_id)
VALUES
    ('Test Barangay 1', ST_MakeEnvelope(121.00, 13.70, 121.075, 13.82, 4326), 1500, 1),
    ('Test Barangay 2', ST_MakeEnvelope(121.075, 13.70, 121.15, 13.82, 4326), 1200, 1);

INSERT INTO nodes (name, barangay_id, feeder_id)
VALUES
    ('N-TEST-01', 1, 1),
    ('N-TEST-02', 2, 1);

INSERT INTO nodes (name, feeder_id) VALUES ('F-A', 1);
