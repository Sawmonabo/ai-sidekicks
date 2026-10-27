//! The approval tables of the daemon's one schema, which runs them before the workflow tables,
//! whose gate answers name an approval request. Every closed set a column holds is written from its
//! enum.
//!
//! The request and resolution tables are projections of the `approval.*` events, written in each
//! event's own write and rebuildable from the log. The daemon keeps no table of approval rules: the
//! providers keep them, and a resolution's remembered scope is written with the record of the rule
//! its answer made. The correction uses table records, once, that an approved card's corrected
//! command or path was carried out, so a restart or a rebuild never lets it run twice; the log
//! holds no event for that use, and no rebuild touches the table. The reviewer blocks table keeps
//! each provider's own record of a block whole, which the event's body may hold only cut short, so
//! an `Allow once` can hand it back.

use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalState, RememberedScopeKind,
};

use crate::database::schema::{SchemaPart, SchemaParts};
use crate::database::sql_list::sql_list_of_every;

/// The questions' list and the approval tables' own part.
pub(crate) fn schema_parts() -> SchemaParts {
    crate::questions::schema::schema_parts()
        .with_part(SchemaPart::new("approval", approval_schema_sql()))
}

fn approval_schema_sql() -> String {
    let categories = sql_list_of_every::<ApprovalCategory>();
    let states = sql_list_of_every::<ApprovalState>();
    let decisions = sql_list_of_every::<ApprovalDecision>();
    let remembered_scope_kinds = sql_list_of_every::<RememberedScopeKind>();
    let pending = <&'static str>::from(ApprovalState::Pending);
    let approved = <&'static str>::from(ApprovalDecision::Approved);
    let rejected = <&'static str>::from(ApprovalDecision::Rejected);
    format!(
        "
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
  category              TEXT NOT NULL CHECK(category IN ({categories})),
  scope                 TEXT NOT NULL,
  -- JSON: the target, with the subject the card names and the provider's own prompt text.
  resource_descriptor   TEXT NOT NULL DEFAULT '{{}}',
  -- The daemon's own id of the provider ask this request was minted for; NULL on a card the
  -- daemon raised itself. Rebuilt from approval.requested, so an answer reaches the right ask
  -- after a restart with several open on one run.
  ask_id                TEXT,
  -- No expired state and no deadline column: a request waits until it is answered, or is
  -- canceled with its run, its session or its provider process.
  state                 TEXT NOT NULL DEFAULT '{pending}' CHECK(state IN ({states})),
  created_at            TEXT NOT NULL,
  -- The last state change; a cancellation settles here and writes no resolution row.
  updated_at            TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_session ON approval_requests(session_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = '{pending}';
-- One request per ask id. The id is minted once for each provider ask the intake takes, so a
-- provider's resent ask is matched to the one it holds in memory, never by this index.
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
  decision                 TEXT NOT NULL CHECK(decision IN ({decisions})),
  -- The request's scope, never broader.
  effective_scope          TEXT NOT NULL,
  -- The rule the answer made, written with the rule's own record once its provider kept it; NULL
  -- for a one-time answer and for a rule its provider did not keep. Its sense follows the decision.
  remembered_scope_kind    TEXT
                           CHECK(remembered_scope_kind IS NULL
                             OR remembered_scope_kind IN ({remembered_scope_kinds})),
  remembered_scope_pattern TEXT,
  -- The rule the answer asked for, written with it, so a resend under the same client resolution
  -- id records that rule and no other; NULL for a one-time answer. Its sense follows the decision.
  asked_scope_kind         TEXT
                           CHECK(asked_scope_kind IS NULL
                             OR asked_scope_kind IN ({remembered_scope_kinds})),
  asked_scope_pattern      TEXT,
  -- The command or path as the person corrected it on the card, which is what runs; NULL for an
  -- answer that changed nothing and for every decline.
  edited_action            TEXT,
  -- The `why not` words the person typed on a decline, which go back to the provider; NULL for a
  -- decline without words and for every approval.
  decline_reason           TEXT,
  resolved_at              TEXT NOT NULL,
  CHECK((remembered_scope_kind IS NULL) = (remembered_scope_pattern IS NULL)),
  CHECK((asked_scope_kind IS NULL) = (asked_scope_pattern IS NULL)),
  CHECK(edited_action IS NULL OR decision = '{approved}'),
  CHECK(decline_reason IS NULL OR decision = '{rejected}')
) STRICT;

-- ---------------------------------------------------------------------------
-- approval_correction_uses: an approved card whose corrected command or path its provider's next
-- ask carried out, one row each, so the correction runs once.
-- ---------------------------------------------------------------------------
-- No REFERENCES: the requests are rebuilt from the log, and this row outlives a rebuild.
CREATE TABLE approval_correction_uses (
  request_id   TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  used_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_approval_correction_uses_session ON approval_correction_uses(session_id);

-- ---------------------------------------------------------------------------
-- reviewer_denials: the provider's own record of each block its reviewer made, written in the
-- block's approval.reviewer.denied write.
-- ---------------------------------------------------------------------------
CREATE TABLE reviewer_denials (
  denial_id        TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  -- JSON: the record as the provider sent it, never cut short.
  provider_denial  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_reviewer_denials_session ON reviewer_denials(session_id);
"
    )
}
