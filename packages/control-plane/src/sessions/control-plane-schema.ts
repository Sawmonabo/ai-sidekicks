// The control plane's Postgres schema, applied whole on a database that has none.
//
// SQL lives in a TypeScript string because `tsc -b` copies no `.sql` file into
// `dist/`, and the package publishes only `dist/`.

/** The whole control-plane schema. `applyMigrations` executes it once, under an advisory lock. */
export const CONTROL_PLANE_SCHEMA_SQL: string = `
-- The identity anchor other tables key on as they are added.
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Witness-only storage: the Merkle root and signature over a range of one
-- daemon's local event log. Event payloads stay on the daemon and are never
-- uploaded. The control plane holds no session record, so session_id is the
-- daemon's session id and carries no foreign key.
CREATE TABLE event_log_anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL,
  node_id           TEXT NOT NULL,                -- the emitting daemon's node id
  start_sequence    BIGINT NOT NULL,              -- first session_events.sequence in the range
  end_sequence      BIGINT NOT NULL,              -- last session_events.sequence in the range
  merkle_root       BYTEA NOT NULL,               -- 32 bytes; BLAKE3 root over row_hash leaves
  root_signature    BYTEA NOT NULL,               -- 64 bytes; the daemon's Ed25519 over merkle_root
  anchored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_sequence >= start_sequence),
  -- end_sequence is in the key, as in the daemon's pending_anchor_uploads: a
  -- cadence anchor [1,1000] and a covering anchor [1,5000] share a start and must
  -- coexist, so the upload's ON CONFLICT DO NOTHING dedups only a re-upload of the
  -- same range. "A covering anchor exists" is a coverage query, never an exact
  -- start match.
  UNIQUE (session_id, node_id, start_sequence, end_sequence)
);

CREATE INDEX idx_event_log_anchors_session ON event_log_anchors(session_id, anchored_at DESC);
CREATE INDEX idx_event_log_anchors_node ON event_log_anchors(node_id, anchored_at DESC);
`;
