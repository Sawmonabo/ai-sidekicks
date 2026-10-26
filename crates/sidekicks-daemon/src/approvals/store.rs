//! The approval tables' statements and reads. Every write is a statement in the event's own write,
//! guarded so a write decided from a stale read is refused whole; every read runs on a read-only
//! connection, which sees each write once it has committed.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalScope, ApprovalState,
    RememberedScope, RememberedScopeKind,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::approvals::request_create::ApprovalResourceDescriptor;
use crate::database::session_scope::SessionScopedSql;
use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::session::directory::lookups::ENDED_SESSION_STATES_SQL;
use crate::session::run::read::{SessionRun, session_run_of_row};
use crate::session::run::transitions::RUN_TERMINAL_STATES_SQL;

/// The distinct statements [`ApprovalRequestReader`] prepares, for the reading connection's
/// statement cache.
pub(crate) const APPROVAL_REQUEST_READER_STATEMENT_CAPACITY: usize = 9;

/// An ask as its rows hold it, with the answers its card may offer and its answer once it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredApprovalRequest {
    /// The ask.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The agent's actor id, or the device a person's request came from.
    pub(crate) requested_by: NonEmptyText,
    /// What the ask is about.
    pub(crate) category: ApprovalCategory,
    /// The target as free text.
    pub(crate) scope: ApprovalScope,
    /// What the card draws.
    pub(crate) resource_descriptor: ApprovalResourceDescriptor,
    /// The daemon's own id of the provider ask the request was minted for; absent on its own card.
    pub(crate) ask_id: Option<NonEmptyText>,
    /// Where the ask stands.
    pub(crate) state: ApprovalState,
    /// When it was raised.
    pub(crate) created_at: WireInstant,
    /// When it last changed.
    pub(crate) updated_at: WireInstant,
    /// Whether an answer may make a rule: never on an ask the provider forbids one on.
    pub(crate) standing_allow_offered: bool,
    /// Whether that rule may be the project's: never on a chat, which has no project, on a card the
    /// daemon raised itself, which no provider relayed, nor on an ask its provider keeps no project
    /// rule for.
    pub(crate) project_scope_offered: bool,
    /// Its one answer, once it has one.
    pub(crate) resolution: Option<StoredApprovalResolution>,
}

impl StoredApprovalRequest {
    /// The rule its answer asked for, once it has an answer that asked for one.
    pub(crate) fn asked_scope(&self) -> Option<&RememberedScope> {
        self.resolution
            .as_ref()
            .and_then(|resolution| resolution.asked_scope.as_ref())
    }
}

/// The one answer an ask received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredApprovalResolution {
    /// The device whose connection carried the answer.
    pub(crate) device_id: DeviceId,
    /// The id the answering client minted.
    pub(crate) client_resolution_id: ClientUuid,
    /// The answer.
    pub(crate) decision: ApprovalDecision,
    /// The recorded scope.
    pub(crate) effective_scope: ApprovalScope,
    /// The rule the answer made, written once its provider kept it and its record landed; absent
    /// for a one-time answer and for a rule that could not be kept.
    pub(crate) remembered_scope: Option<RememberedScope>,
    /// The rule the answer asked for, written with it, which a resend records and never another;
    /// absent for a one-time answer.
    pub(crate) asked_scope: Option<RememberedScope>,
    /// The command or path as the person corrected it, on an approval that changed it.
    pub(crate) edited_action: Option<NonEmptyText>,
    /// The `why not` words, on a decline the person typed them on.
    pub(crate) decline_reason: Option<NonEmptyText>,
    /// When it was answered.
    pub(crate) resolved_at: WireInstant,
}

/// A new ask as its row records it, pending from `created_at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InsertedApprovalRequest {
    /// The ask.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run.
    pub(crate) run_id: RunId,
    /// The agent's actor id, or the device a person's request came from.
    pub(crate) requested_by: NonEmptyText,
    /// What the ask is about.
    pub(crate) category: ApprovalCategory,
    /// The target as free text.
    pub(crate) scope: ApprovalScope,
    /// What the card draws.
    pub(crate) resource_descriptor: ApprovalResourceDescriptor,
    /// The daemon's own id of the provider ask; absent on a card the daemon raised itself.
    pub(crate) ask_id: Option<NonEmptyText>,
    /// When it was raised.
    pub(crate) created_at: WireInstant,
}

/// An answer as its resolution row records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InsertedApprovalResolution {
    /// The ask.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// The device whose connection carried the answer.
    pub(crate) device_id: DeviceId,
    /// The id the answering client minted.
    pub(crate) client_resolution_id: ClientUuid,
    /// The answer.
    pub(crate) decision: ApprovalDecision,
    /// The recorded scope.
    pub(crate) effective_scope: ApprovalScope,
    /// The rule the answer asks for; absent for a one-time answer.
    pub(crate) asked_scope: Option<RememberedScope>,
    /// The command or path as the person corrected it, on an approval that changed it.
    pub(crate) edited_action: Option<NonEmptyText>,
    /// The `why not` words, on a decline the person typed them on.
    pub(crate) decline_reason: Option<NonEmptyText>,
    /// When it was answered.
    pub(crate) resolved_at: WireInstant,
}

/// How an ask settles: with the person's answer, or canceled with its run, its session or its
/// provider process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApprovalSettlement {
    /// Answered.
    Decided(ApprovalDecision),
    /// Ended without an answer.
    Canceled,
}

impl ApprovalSettlement {
    /// The state the ask settles in.
    pub(crate) fn state(self) -> ApprovalState {
        match self {
            Self::Decided(ApprovalDecision::Approved) => ApprovalState::Approved,
            Self::Decided(ApprovalDecision::Rejected) => ApprovalState::Rejected,
            Self::Canceled => ApprovalState::Canceled,
        }
    }
}

/// The narrowing of one session's asks a read may ask for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovalRequestFilter {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Only asks in this state.
    pub(crate) state: Option<ApprovalState>,
    /// Only asks about this.
    pub(crate) category: Option<ApprovalCategory>,
}

/// One correction carried out: the approved card whose corrected command or path ran, and when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovalCorrectionUse {
    /// The approved card.
    pub(crate) approval_request_id: ApprovalRequestId,
    /// Its session.
    pub(crate) session_id: SessionId,
    /// When the correction ran.
    pub(crate) used_at: WireInstant,
}

static SESSION_OPEN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions
  WHERE id = @session_id
    AND state NOT IN ({})",
        *ENDED_SESSION_STATES_SQL
    )
});

static RUN_LIVE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM runs
  WHERE run_id = @run_id
    AND session_id = @session_id
    AND state NOT IN ({})",
        *RUN_TERMINAL_STATES_SQL
    )
});

static INSERT_REQUEST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO approval_requests
    (id, session_id, run_id, requested_by, category, scope, resource_descriptor, ask_id, state,
     created_at, updated_at)
  VALUES (@id, @session_id, @run_id, @requested_by, @category, @scope, @resource_descriptor,
          @ask_id, '{}', @created_at, @created_at)",
        pending()
    )
});

// A rebuild's write of an ask: a row a workflow gate's answer names outlives the rebuild's clear,
// since no rebuild writes the gate's rows, and is written over with what the log says.
static REWRITE_REQUEST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
  ON CONFLICT (id) DO UPDATE SET
    session_id = excluded.session_id, run_id = excluded.run_id,
    requested_by = excluded.requested_by, category = excluded.category, scope = excluded.scope,
    resource_descriptor = excluded.resource_descriptor, ask_id = excluded.ask_id,
    state = excluded.state, created_at = excluded.created_at, updated_at = excluded.updated_at",
        *INSERT_REQUEST_SQL
    )
});

static SETTLE_PENDING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE approval_requests
    SET state = @state, updated_at = @updated_at
  WHERE id = @id
    AND state = '{}'",
        pending()
    )
});

const INSERT_RESOLUTION_SQL: &str = "INSERT INTO approval_resolutions
    (request_id, device_id, client_resolution_id, decision, effective_scope, asked_scope_kind,
     asked_scope_pattern, edited_action, decline_reason, resolved_at)
  VALUES (@request_id, @device_id, @client_resolution_id, @decision, @effective_scope,
          @asked_scope_kind, @asked_scope_pattern, @edited_action, @decline_reason,
          @resolved_at)";

// A rebuild's write of an answer: the answer of an ask a workflow gate names outlives the
// rebuild's clear with its ask, and is written over with what the log says, the rule asked for
// from the answer's event and the rule made cleared until the log's own rule event writes it.
static REWRITE_RESOLUTION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{INSERT_RESOLUTION_SQL}
  ON CONFLICT (request_id) DO UPDATE SET
    device_id = excluded.device_id, client_resolution_id = excluded.client_resolution_id,
    decision = excluded.decision, effective_scope = excluded.effective_scope,
    remembered_scope_kind = NULL, remembered_scope_pattern = NULL,
    asked_scope_kind = excluded.asked_scope_kind,
    asked_scope_pattern = excluded.asked_scope_pattern,
    edited_action = excluded.edited_action, decline_reason = excluded.decline_reason,
    resolved_at = excluded.resolved_at"
    )
});

// Refused, by changing no row, once the correction was carried out.
const INSERT_CORRECTION_USE_SQL: &str = "INSERT INTO approval_correction_uses
    (request_id, session_id, used_at)
  VALUES (@request_id, @session_id, @used_at)
  ON CONFLICT (request_id) DO NOTHING";

const SET_REMEMBERED_SCOPE_SQL: &str = "UPDATE approval_resolutions
    SET remembered_scope_kind = @kind, remembered_scope_pattern = @pattern
  WHERE request_id = @request_id";

fn pending() -> &'static str {
    ApprovalState::Pending.into()
}

// Every read of asks selects these columns, in this order, which `stored_request_of` reads.
const SELECT_REQUESTS_SQL: &str = "SELECT request.id, request.session_id, request.run_id,
       request.requested_by, request.category, request.scope, request.resource_descriptor,
       request.ask_id, request.state, request.created_at, request.updated_at,
       resolution.device_id, resolution.client_resolution_id, resolution.decision,
       resolution.effective_scope, resolution.remembered_scope_kind,
       resolution.remembered_scope_pattern, resolution.asked_scope_kind,
       resolution.asked_scope_pattern, resolution.edited_action, resolution.decline_reason,
       resolution.resolved_at, session.shape AS session_shape
  FROM approval_requests AS request
  LEFT JOIN approval_resolutions AS resolution ON resolution.request_id = request.id
  LEFT JOIN sessions AS session ON session.id = request.session_id";

static SELECT_REQUEST_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{SELECT_REQUESTS_SQL} WHERE request.id = ?"));

static SELECT_ASK_REQUEST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  WHERE request.run_id = @run_id AND request.ask_id = @ask_id"
    )
});

static SELECT_SESSION_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  WHERE request.session_id = @session_id
    AND (@state IS NULL OR request.state = @state)
    AND (@category IS NULL OR request.category = @category)
  ORDER BY request.created_at, request.id"
    )
});

static SELECT_PENDING_FOR_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  WHERE request.run_id = ? AND request.state = '{}'
  ORDER BY request.created_at, request.id",
        pending()
    )
});

static SELECT_PENDING_FOR_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  WHERE request.session_id = ? AND request.state = '{}'
  ORDER BY request.created_at, request.id",
        pending()
    )
});

static SELECT_ENDED_SESSIONS_WITH_PENDING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT request.session_id
  FROM approval_requests AS request
  JOIN sessions AS session ON session.id = request.session_id
  WHERE request.state = '{}'
    AND session.state IN ({})",
        pending(),
        *ENDED_SESSION_STATES_SQL
    )
});

// Every ended run holding an ask still pending, with its session.
static SELECT_ENDED_RUNS_WITH_PENDING_SQL: LazyLock<SessionScopedSql> = LazyLock::new(|| {
    SessionScopedSql::new("request.session_id", |session_condition| {
        format!(
            "SELECT DISTINCT request.run_id, request.session_id
  FROM approval_requests AS request
  JOIN runs ON runs.run_id = request.run_id
  WHERE request.state = '{}'
    AND runs.state IN ({})
    {session_condition}",
            pending(),
            *RUN_TERMINAL_STATES_SQL
        )
    })
});

static SELECT_SESSION_ENDED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions
  WHERE id = ? AND state IN ({})",
        *ENDED_SESSION_STATES_SQL
    )
});

/// A guard that refuses its write once the session is closed or being deleted.
pub(crate) fn session_open_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SESSION_OPEN_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding(
            "@session_id",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// A guard that refuses its write unless the run is the session's and has not ended.
pub(crate) fn run_live_statement(session_id: &SessionId, run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RUN_LIVE_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@session_id", session_id.text().as_str()),
            text_binding("@run_id", run_id.text().as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that records a new pending ask.
pub(crate) fn insert_request_statement(request: &InsertedApprovalRequest) -> WriteStatement {
    request_statement(&INSERT_REQUEST_SQL, request)
}

/// The statement a rebuild records an ask with: the live one's row, written over a row the
/// rebuild kept because a workflow gate's answer names it.
pub(crate) fn rewrite_request_statement(request: &InsertedApprovalRequest) -> WriteStatement {
    request_statement(&REWRITE_REQUEST_SQL, request)
}

/// The statement that settles an ask as `settlement` says at `settled_at`, refused unless it is
/// still pending.
pub(crate) fn settle_pending_statement(
    approval_request_id: &ApprovalRequestId,
    settlement: ApprovalSettlement,
    settled_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SETTLE_PENDING_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", approval_request_id.text().as_str()),
            text_binding("@state", <&'static str>::from(settlement.state())),
            text_binding("@updated_at", settled_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that records an ask's one answer.
pub(crate) fn insert_resolution_statement(
    resolution: &InsertedApprovalResolution,
) -> WriteStatement {
    resolution_statement(INSERT_RESOLUTION_SQL, resolution)
}

/// The statement a rebuild records an answer with: the live one's row, written over the answer
/// the rebuild kept with its ask because a workflow gate's answer names it.
pub(crate) fn rewrite_resolution_statement(
    resolution: &InsertedApprovalResolution,
) -> WriteStatement {
    resolution_statement(REWRITE_RESOLUTION_SQL.as_str(), resolution)
}

// The insert and the rebuild's rewrite bind the same values.
fn resolution_statement(
    sql: &'static str,
    resolution: &InsertedApprovalResolution,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding(
                "@request_id",
                resolution.approval_request_id.text().as_str(),
            ),
            text_binding("@device_id", resolution.device_id.as_str()),
            text_binding(
                "@client_resolution_id",
                resolution.client_resolution_id.as_str(),
            ),
            text_binding("@decision", <&'static str>::from(resolution.decision)),
            text_binding("@effective_scope", resolution.effective_scope.as_str()),
            nullable_text_binding(
                "@asked_scope_kind",
                resolution
                    .asked_scope
                    .as_ref()
                    .map(|asked_scope| <&'static str>::from(asked_scope.kind)),
            ),
            nullable_text_binding(
                "@asked_scope_pattern",
                resolution
                    .asked_scope
                    .as_ref()
                    .map(|asked_scope| asked_scope.pattern.as_str()),
            ),
            nullable_text_binding(
                "@edited_action",
                resolution.edited_action.as_ref().map(NonEmptyText::as_str),
            ),
            nullable_text_binding(
                "@decline_reason",
                resolution.decline_reason.as_ref().map(NonEmptyText::as_str),
            ),
            text_binding("@resolved_at", resolution.resolved_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that records the one carrying out of an approved card's corrected command or
/// path, refused when it was carried out already.
pub(crate) fn insert_correction_use_statement(
    correction_use: &ApprovalCorrectionUse,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_CORRECTION_USE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding(
                "@request_id",
                correction_use.approval_request_id.text().as_str(),
            ),
            text_binding("@session_id", correction_use.session_id.text().as_str()),
            text_binding("@used_at", correction_use.used_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The statement that writes onto an ask's answer the rule it made, in that rule's own record;
/// refused when the ask has no answer.
pub(crate) fn remembered_scope_statement(
    approval_request_id: &ApprovalRequestId,
    remembered_scope: &RememberedScope,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SET_REMEMBERED_SCOPE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@request_id", approval_request_id.text().as_str()),
            text_binding("@kind", <&'static str>::from(remembered_scope.kind)),
            text_binding("@pattern", remembered_scope.pattern.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

// The insert and the rebuild's rewrite bind the same values.
fn request_statement(
    sql: &'static LazyLock<String>,
    request: &InsertedApprovalRequest,
) -> WriteStatement {
    let resource_descriptor = serde_json::to_string(&request.resource_descriptor)
        .expect("a descriptor of text, flags and string-keyed members always serializes");
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", request.approval_request_id.text().as_str()),
            text_binding("@session_id", request.session_id.text().as_str()),
            text_binding("@run_id", request.run_id.text().as_str()),
            text_binding("@requested_by", request.requested_by.as_str()),
            text_binding("@category", <&'static str>::from(request.category)),
            text_binding("@scope", request.scope.as_str()),
            (
                Cow::Borrowed("@resource_descriptor"),
                Value::Text(resource_descriptor),
            ),
            nullable_text_binding("@ask_id", request.ask_id.as_ref().map(NonEmptyText::as_str)),
            text_binding("@created_at", request.created_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Reads asks and their answers on a read-only connection, inside a read of the daemon's read
/// pool. A stored value that does not read as its type, a descriptor among them, fails the read
/// with `rusqlite::Error::FromSqlConversionFailure`, keeping why.
pub(crate) struct ApprovalRequestReader<'connection> {
    /// The read-only connection.
    reader: &'connection Connection,
}

impl<'connection> ApprovalRequestReader<'connection> {
    /// A reader over `reader`, a read-only connection.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The ask under `approval_request_id`, or `None` when the daemon holds none.
    pub(crate) fn read_request(
        &self,
        approval_request_id: &ApprovalRequestId,
    ) -> rusqlite::Result<Option<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_REQUEST_SQL)?
            .query_row([approval_request_id.text().as_str()], stored_request_of)
            .optional()
    }

    /// The request minted for the run's provider ask `ask_id`, or `None` when it has none.
    pub(crate) fn read_ask_request(
        &self,
        run_id: &RunId,
        ask_id: &NonEmptyText,
    ) -> rusqlite::Result<Option<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_ASK_REQUEST_SQL)?
            .query_row(
                named_params! {
                    "@run_id": run_id.text().as_str(),
                    "@ask_id": ask_id.as_str(),
                },
                stored_request_of,
            )
            .optional()
    }

    /// One session's asks, oldest first, narrowed as `filter` asks.
    pub(crate) fn list_session_requests(
        &self,
        filter: &ApprovalRequestFilter,
    ) -> rusqlite::Result<Vec<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_SESSION_REQUESTS_SQL)?
            .query_map(
                named_params! {
                    "@session_id": filter.session_id.text().as_str(),
                    "@state": filter.state.map(<&'static str>::from),
                    "@category": filter.category.map(<&'static str>::from),
                },
                stored_request_of,
            )?
            .collect()
    }

    /// The run's asks still pending, oldest first.
    pub(crate) fn list_pending_for_run(
        &self,
        run_id: &RunId,
    ) -> rusqlite::Result<Vec<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_PENDING_FOR_RUN_SQL)?
            .query_map([run_id.text().as_str()], stored_request_of)?
            .collect()
    }

    /// The session's asks still pending across all its runs, oldest first.
    pub(crate) fn list_pending_for_session(
        &self,
        session_id: &SessionId,
    ) -> rusqlite::Result<Vec<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_PENDING_FOR_SESSION_SQL)?
            .query_map([session_id.text().as_str()], stored_request_of)?
            .collect()
    }

    /// The closed sessions, or those being deleted, that still hold a pending ask.
    pub(crate) fn list_ended_sessions_with_pending(&self) -> rusqlite::Result<Vec<SessionId>> {
        self.reader
            .prepare_cached(&SELECT_ENDED_SESSIONS_WITH_PENDING_SQL)?
            .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
            .collect()
    }

    /// The runs of `session_id`, or of every session when it is `None`, that have ended while an
    /// ask of theirs is still pending: what a daemon that went down between a run's end and the
    /// cancel of its asks left.
    pub(crate) fn list_ended_runs_with_pending(
        &self,
        session_id: Option<&SessionId>,
    ) -> rusqlite::Result<Vec<SessionRun>> {
        SELECT_ENDED_RUNS_WITH_PENDING_SQL.query(self.reader, session_id, session_run_of_row)
    }

    /// Whether the session is closed or being deleted.
    pub(crate) fn is_session_ended(&self, session_id: &SessionId) -> rusqlite::Result<bool> {
        self.reader
            .prepare_cached(&SELECT_SESSION_ENDED_SQL)?
            .exists([session_id.text().as_str()])
    }
}

/// Stored text that is not a device id.
#[derive(Debug, thiserror::Error)]
#[error("the stored device id is not a device id")]
struct NotADeviceId;

/// Stored text that is empty where its column holds text.
#[derive(Debug, thiserror::Error)]
#[error("the stored text is empty")]
struct EmptyStoredText;

fn non_empty_text(text: String) -> Result<NonEmptyText, EmptyStoredText> {
    NonEmptyText::new(text).ok_or(EmptyStoredText)
}

// Reads the columns `SELECT_REQUESTS_SQL` selects, in its order.
fn stored_request_of(row: &Row<'_>) -> rusqlite::Result<StoredApprovalRequest> {
    // Written by the create from a typed descriptor, so it reads back as one.
    let resource_descriptor: ApprovalResourceDescriptor =
        text_column(row, 6, |text| serde_json::from_str(&text))?;
    let ask_id = optional_text_column(row, 7, non_empty_text)?;
    let session_shape: Option<SessionShape> = optional_text_column(row, 22, closed_word)?;
    let standing_allow_offered = resource_descriptor.standing_allow_offered;
    let project_scope_offered = standing_allow_offered
        && resource_descriptor.project_scope_offered
        && ask_id.is_some()
        && session_shape == Some(SessionShape::Project);
    Ok(StoredApprovalRequest {
        approval_request_id: text_column(row, 0, |text| ApprovalRequestId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        run_id: text_column(row, 2, |text| RunId::new(&text))?,
        requested_by: text_column(row, 3, non_empty_text)?,
        category: text_column(row, 4, closed_word)?,
        scope: text_column(row, 5, ApprovalScope::new)?,
        resource_descriptor,
        ask_id,
        state: text_column(row, 8, closed_word)?,
        created_at: text_column(row, 9, WireInstant::try_from)?,
        updated_at: text_column(row, 10, WireInstant::try_from)?,
        standing_allow_offered,
        project_scope_offered,
        resolution: resolution_of(row)?,
    })
}

// A resolution row's columns are all NOT NULL, so its device id tells whether it joined; once it
// did, a missing column fails the read.
fn resolution_of(row: &Row<'_>) -> rusqlite::Result<Option<StoredApprovalResolution>> {
    let Some(device_id) =
        optional_text_column(row, 11, |text| DeviceId::new(text).ok_or(NotADeviceId))?
    else {
        return Ok(None);
    };
    let decision: ApprovalDecision = text_column(row, 13, closed_word)?;
    Ok(Some(StoredApprovalResolution {
        device_id,
        client_resolution_id: text_column(row, 12, ClientUuid::new)?,
        decision,
        effective_scope: text_column(row, 14, ApprovalScope::new)?,
        remembered_scope: rule_scope_of(row, 15, decision)?,
        asked_scope: rule_scope_of(row, 17, decision)?,
        edited_action: optional_text_column(row, 19, non_empty_text)?,
        decline_reason: optional_text_column(row, 20, non_empty_text)?,
        resolved_at: text_column(row, 21, WireInstant::try_from)?,
    }))
}

// A rule's reach and subject, read from the column at `kind_at` and the one after it; its sense
// follows the decision.
fn rule_scope_of(
    row: &Row<'_>,
    kind_at: usize,
    decision: ApprovalDecision,
) -> rusqlite::Result<Option<RememberedScope>> {
    let kind: Option<RememberedScopeKind> = optional_text_column(row, kind_at, closed_word)?;
    let pattern = optional_text_column(row, kind_at + 1, non_empty_text)?;
    Ok(match (kind, pattern) {
        (Some(kind), Some(pattern)) => Some(RememberedScope {
            kind,
            pattern,
            sense: decision.remembered_sense(),
        }),
        (None, _) | (_, None) => None,
    })
}
