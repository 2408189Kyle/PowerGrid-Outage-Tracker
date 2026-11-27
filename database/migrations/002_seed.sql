INSERT INTO substations (name) VALUES ('Substation 1');

INSERT INTO feeders (name, substation_id)
VALUES ('Feeder A', 1), ('Feeder B', 1), ('Feeder C', 1);

INSERT INTO barangays (name, boundary, households_estimate, feeder_id)
VALUES
    ('Poblacion', ST_MakeEnvelope(121.00, 13.70, 121.075, 13.82, 4326), 1500, 1),
    ('Alangilan', ST_MakeEnvelope(121.075, 13.70, 121.15, 13.82, 4326), 1200, 1),
    ('Pallocan West', NULL, 1000, 2),
    ('Kumintang Ibaba', NULL, 1000, 2),
    ('Bolbok', NULL, 1000, 3),
    ('Sta. Rita Karsada', NULL, 1000, 3);

INSERT INTO nodes (name, barangay_id, feeder_id)
VALUES
    ('N-POBLACION', 1, 1),
    ('N-ALANGILAN', 2, 1),
    ('N-PALLOCAN-WEST', 3, 2),
    ('N-KUMINTANG-IBABA', 4, 2),
    ('N-BOLBOK', 5, 3),
    ('N-STA-RITA-KARSADA', 6, 3);

INSERT INTO nodes (name, feeder_id)
VALUES ('F-A', 1), ('F-B', 2), ('F-C', 3);
