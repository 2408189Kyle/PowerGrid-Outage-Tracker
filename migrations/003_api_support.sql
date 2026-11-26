CREATE TABLE IF NOT EXISTS community_feedback (
    id serial PRIMARY KEY,
    barangay_id int NOT NULL REFERENCES barangays(id),
    location text NOT NULL,
    comment text NOT NULL,
    author_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_feedback_created_at
    ON community_feedback (created_at DESC);
