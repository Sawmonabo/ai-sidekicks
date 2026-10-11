// The approval tables of the daemon's one schema, appended to it in `session/daemon-schema.ts`
// before the workflow tables, whose gate answers name an approval request.
//
// The request and resolution tables are projections of the `approval.*` events, written in each
// event's own write and rebuildable from the log. The daemon keeps no table of approval rules: the
// providers keep them, and a resolution's remembered scope is the record of the rule its answer
// handed over. The reviewer blocks table keeps each provider's own record of a block whole, which
// the event's body may hold only cut short, so an `Allow once` can hand it back.

/** The SQL of the approval tables and their indexes, run as part of the daemon schema's script. */
export const APPROVAL_SCHEMA_SQL: string = `
-- ---------------------------------------------------------------------------
-- approval_requests: one row per ask, from a provider or from the daemon itself.
-- ---------------------------------------------------------------------------
-- No REFERENCES on run_id or session_id: run state and the session's own record are event-sourced.
CREATE TABLE approval_requests (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  -- The agent's actor id, or the device a person's request came from.
  requested_by          TEXT NOT NULL,
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'plan_approval', 'gate'
                        )),
  scope                 TEXT NOT NULL,
  -- JSON: the target, with the subject the card names and the provider's own prompt text.
  resource_descriptor   TEXT NOT NULL DEFAULT '{}',
  -- The daemon's own id of the provider ask this request was minted for; NULL on a card the
  -- daemon raised itself. Rebuilt from approval.requested, so an answer reaches the right ask
  -- after a restart with several open on one run.
  ask_id                TEXT,
  -- No expired state and no deadline column: a request waits until it is answered, or is
  -- canceled with its run, its session or its provider process.
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'approved', 'rejected', 'canceled')),
  created_at            TEXT NOT NULL,
  -- The last state change; a cancellation settles here and writes no resolution row.
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';
-- One request per provider ask: a retried or rebuilt mint collides here instead of leaving a
-- second pending row whose answer would reach the ask twice.
CREATE UNIQUE INDEX idx_approval_requests_ask ON approval_requests(run_id, ask_id)
  WHERE ask_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- approval_resolutions: the one answer to a request; the first answer from any device settles it.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_resolutions (
  request_id               TEXT PRIMARY KEY REFERENCES approval_requests(id),
  -- The device whose connection carried the answer; every other device reads it as answered there.
  device_id                TEXT NOT NULL,
  -- Minted by the answering client and echoed on the resolution event; the same id sent again is
  -- answered with this row.
  client_resolution_id     TEXT NOT NULL,
  decision                 TEXT NOT NULL
                           CHECK(decision IN ('approved', 'rejected')),
  -- The request's scope, never broader.
  effective_scope          TEXT NOT NULL,
  -- The rule the answer handed to the provider, NULL for a one-time answer; its sense follows the
  -- decision.
  remembered_scope_kind    TEXT
                           CHECK(remembered_scope_kind IS NULL
                             OR remembered_scope_kind IN ('session', 'project')),
  remembered_scope_pattern TEXT,
  resolved_at              TEXT NOT NULL,
  CHECK((remembered_scope_kind IS NULL) = (remembered_scope_pattern IS NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- reviewer_denials: the provider's own record of each block its reviewer made, written in the
-- block's approval.reviewer_denied write.
-- ---------------------------------------------------------------------------
CREATE TABLE reviewer_denials (
  denial_id        TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  -- JSON: the record as the provider sent it, never cut short.
  provider_denial  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_reviewer_denials_session ON reviewer_denials(session_id);
`;
