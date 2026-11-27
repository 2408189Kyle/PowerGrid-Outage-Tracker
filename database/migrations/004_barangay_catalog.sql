UPDATE barangays
SET name = 'Poblacion'
WHERE name = 'Test Barangay 1'
  AND NOT EXISTS (SELECT 1 FROM barangays WHERE name = 'Poblacion');

UPDATE barangays
SET name = 'Alangilan'
WHERE name = 'Test Barangay 2'
  AND NOT EXISTS (SELECT 1 FROM barangays WHERE name = 'Alangilan');

INSERT INTO barangays (name, households_estimate, feeder_id)
VALUES
    ('Pallocan West', 1000, 2),
    ('Kumintang Ibaba', 1000, 2),
    ('Bolbok', 1000, 1),
    ('Sta. Rita Karsada', 1000, 2)
ON CONFLICT (name) DO NOTHING;
