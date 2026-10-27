//! The standing rules a person's answers made. The providers keep them, and the daemon keeps no
//! table of its own: each rule is the `approval.rule.remembered` event its answer wrote, in force
//! until an `approval.rule.revoked` event names it, and a rule's id is the id of the ask that made
//! it, so a revoke finds its rule through that ask's row.
//!
//! - A session's rules in force are its own and its project's: a project rule made in any session
//!   of the same project reaches every one of them, through each provider's own rules, written into
//!   every working folder of the project, and the daemon's answers to asks.
//! - A rule is recorded once its provider kept it, so the record never names a rule the provider
//!   lacks; a record that fails takes it back out of the provider.
//! - One rule stands per kind, subject and action within its reach: a new one is recorded first,
//!   then the one it replaces is revoked, so a failure between them leaves both standing, never
//!   neither, and a block outranks an allow over the same subject.
//! - A revoke takes the rule out of force where its provider keeps it before it returns: out of the
//!   project's files first for a project rule, so a failure there leaves it listed and in force,
//!   then, once the record lands, out of the rules of every session it reached, each provider
//!   reading them again without it. A session rule also ends with its session, and a project rule
//!   leaves the providers with the purge of the session that made it.
//! - Rule writes are made one at a time, so two revokes of one rule never both land.
//! - A rule made on a card the daemon raised itself, for a call of the app's own tools, is a
//!   session rule the daemon keeps and honors alone: no provider holds it, so its record, the
//!   rule it replaces and its revoke reach no provider, and no provider is handed it.

mod driver_reads;
pub mod session_end;

use std::path::PathBuf;
use std::slice;
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use rusqlite::{Connection, OptionalExtension, Row, named_params};
use sidekicks_contracts::approval::events::{
    ApprovalRuleRememberedPayload, ApprovalRuleRevokedPayload,
};
use sidekicks_contracts::approval::{
    ApprovalCategory, ApprovalRequestId, ApprovalRuleListResponse, ApprovalRuleRevokeResponse,
    ApprovalScope, ExplicitInvalidation, InvalidationTrigger, RememberedRule, RememberedRuleId,
    RememberedRuleSense, RememberedScope, RememberedScopeKind,
};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use tokio::task::JoinError;

use crate::refusals::{
    approval_rule_already_revoked, approval_rule_not_found, approval_rule_revoke_not_kept,
};
use crate::store::{StoredApprovalRequest, remembered_scope_statement};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::contract::DriverError;
use sidekicks_provider::driver::session_control::RevokeRuleParams;
use sidekicks_provider::port::permission_ask::{ProviderAnswerRule, ProviderAskAction};
use sidekicks_session::directory::lookups::{session_exists, session_project_sql};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::log_service::EventAppendError;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::pending::PendingSessions;
use sidekicks_store::events::session::skipped_ranges::outside_skipped_ranges_sql;
use sidekicks_workspace::schema::MountOrigin;

/// The distinct statements [`ApprovalRules`] prepares, for the reading connection's statement
/// cache.
pub const APPROVAL_RULES_STATEMENT_CAPACITY: usize = 8;

/// Takes a revoked rule out of force at the provider of one session, through its driver's
/// `revoke_rule`; the daemon's start supplies it. Fails with the driver's own error.
pub type RevokeAtProvider =
    Box<dyn Fn(RevokeRuleParams) -> BoxFuture<'static, Result<(), DriverError>> + Send + Sync>;

/// Why a rule could not be read, recorded or revoked.
#[derive(Debug, thiserror::Error)]
pub enum ApprovalRuleError {
    /// `session.notFound`, `approval.rule.notFound`, `approval.rule.alreadyRevoked`, or
    /// `approval.rule.notKept` for a revoke whose rule stayed in a project's rule file.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the approval rules failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A provider could not take the rule out of force, or put a session's rules back.
    #[error("a provider could not take the rule out of force")]
    Provider(#[source] DriverError),
    /// The rule names no subject, so no record can name it.
    #[error("the rule names an empty subject")]
    EmptySubject,
    /// The rule's event breaks a check of its type.
    #[error("the rule's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the rule's event.
    #[error("the rule's event was not recorded")]
    Append(#[from] SessionEventAppendError),
    /// The reading of the ask's command line did not finish.
    #[error("the ask's command line was not read")]
    LineReading(#[from] JoinError),
    /// The rule's record failed, beside the failure of taking it back out of its provider.
    #[error(transparent)]
    NotRecorded(Box<CleanupFailures<ApprovalRuleError>>),
}

impl From<ApprovalRuleError> for HandlerError {
    /// A refusal answers by its code, the session's refusal of a rule's event among them; the rest
    /// are faults in the daemon.
    fn from(error: ApprovalRuleError) -> Self {
        match error {
            ApprovalRuleError::Refused(refusal) => Self::Refused(refusal),
            ApprovalRuleError::Append(SessionEventAppendError::Append(
                EventAppendError::SessionWriteRefused(refusal),
            )) => Self::Refused(refusal.into()),
            fault @ (ApprovalRuleError::Database(_)
            | ApprovalRuleError::Pool(_)
            | ApprovalRuleError::Provider(_)
            | ApprovalRuleError::EmptySubject
            | ApprovalRuleError::Draft(_)
            | ApprovalRuleError::Append(_)
            | ApprovalRuleError::LineReading(_)
            | ApprovalRuleError::NotRecorded(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The project rules a purged session made, taken out of the project's files, and the other
/// sessions of the project whose providers read their rules again once the purge has run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawnProjectRules {
    rules: Vec<ProviderAskRule>,
    other_sessions: Vec<SessionId>,
}

/// One rule in force as the log holds it, with the action kind its ask's row names and whether the
/// daemon keeps it alone, made on a card no provider raised.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RuleRow {
    session_id: SessionId,
    rule_id: RememberedRuleId,
    remembered_scope: RememberedScope,
    action: ProviderAskActionKind,
    category: ApprovalCategory,
    scope: ApprovalScope,
    granted_at: WireInstant,
    is_daemon_kept: bool,
}

// The rule a row selected with `RULE_SELECT_LIST_SQL` names.
const RULE_SELECT_LIST_SQL: &str = "remembered.session_id,
       json_extract(remembered.payload, '$.ruleId') AS rule_id,
       json_extract(remembered.payload, '$.rememberedScope') AS remembered_scope,
       json_extract(request.resource_descriptor, '$.action') AS action,
       request.category, request.scope, remembered.occurred_at AS granted_at,
       request.ask_id IS NULL AS is_daemon_kept";

// A rule whose ask's row still stands, names the action the rule covers, and whose event lies
// outside every range its session skipped as damaged.
static RULE_SOURCE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "FROM session_events AS remembered
  JOIN approval_requests AS request
    ON request.id = json_extract(remembered.payload, '$.approvalRequestId')
  WHERE remembered.type = '{}'
    AND json_valid(remembered.payload)
    AND json_extract(request.resource_descriptor, '$.action.kind') IS NOT NULL
    AND {}",
        SessionEventType::ApprovalRuleRemembered.as_str(),
        outside_skipped_ranges_sql("remembered")
    )
});

static NOT_REVOKED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "NOT EXISTS (SELECT 1 FROM session_events AS revoked
    WHERE revoked.session_id = remembered.session_id
      AND revoked.type = '{}'
      AND json_valid(revoked.payload)
      AND json_extract(revoked.payload, '$.ruleId')
        = json_extract(remembered.payload, '$.ruleId'))",
        SessionEventType::ApprovalRuleRevoked.as_str()
    )
});

// The sessions of the session's project, itself among them; a chat's own alone. The project is
// read once, and its sessions are found through the indexes on a mount's and a create request's
// project, each then checked to belong to the project now.
static PROJECT_SESSIONS_CTE: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH
  session_project(id) AS (SELECT {}),
  project_sessions(id) AS (
    SELECT @session_id
    UNION SELECT candidate.id FROM (
        SELECT workspace.session_id AS id FROM repo_mounts AS mount
          JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
         WHERE mount.project_id = (SELECT id FROM session_project) AND mount.origin = '{}'
        UNION SELECT request.session_id FROM session_create_requests AS request
         WHERE request.project_id = (SELECT id FROM session_project)) AS candidate
      JOIN sessions AS session ON session.id = candidate.id
     WHERE {} = (SELECT id FROM session_project))",
        session_project_sql("@session_id"),
        <&'static str>::from(MountOrigin::Attached),
        session_project_sql("candidate.id")
    )
});

// The rules in force on a session: its own, and its project's made in any of the project's
// sessions.
static SELECT_RULES_IN_FORCE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}
  SELECT {RULE_SELECT_LIST_SQL} {}
    AND remembered.session_id IN (SELECT id FROM project_sessions)
    AND (remembered.session_id = @session_id
      OR json_extract(remembered.payload, '$.rememberedScope.kind') = '{}')
    AND {}
  ORDER BY remembered.occurred_at, remembered.sequence",
        *PROJECT_SESSIONS_CTE,
        *RULE_SOURCE_SQL,
        <&'static str>::from(RememberedScopeKind::Project),
        *NOT_REVOKED_SQL
    )
});

// The session's own rules in force, of both kinds: its session rules, which its end revokes, and
// its project rules, which its purge takes out of the providers.
static SELECT_OWN_RULES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {RULE_SELECT_LIST_SQL} {}
    AND remembered.session_id = @session_id
    AND {}
  ORDER BY remembered.occurred_at, remembered.sequence",
        *RULE_SOURCE_SQL, *NOT_REVOKED_SQL
    )
});

// A rule by its id, which is its ask's, and whether it is still in force.
static SELECT_RULE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {RULE_SELECT_LIST_SQL}, {} AS in_force
  {}
    AND remembered.session_id = (SELECT session_id FROM approval_requests WHERE id = @rule_id)
    AND json_extract(remembered.payload, '$.ruleId') = @rule_id",
        *NOT_REVOKED_SQL, *RULE_SOURCE_SQL
    )
});

static SELECT_PROJECT_SESSIONS_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{} SELECT id FROM project_sessions", *PROJECT_SESSIONS_CTE));

// The working folders of the session's project, each worktree's own: the live ones a rule is
// written into, or with the archived ones too, which a rule is taken out of where its file stayed.
static SELECT_PROJECT_FOLDERS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT workspace.fs_root AS folder
  FROM repo_mounts AS mount
  JOIN workspaces AS workspace ON workspace.repo_mount_id = mount.id
  WHERE mount.project_id = {}
    AND workspace.fs_root IS NOT NULL
    AND (@includes_archived = 1 OR workspace.state <> '{}')
  ORDER BY workspace.fs_root",
        session_project_sql("@session_id"),
        <&'static str>::from(WorkspaceState::Archived)
    )
});

// The one key every rule write is made under.
type RuleWriteHold<'lock> = KeyHold<'lock, ()>;

/// Records, reads and revokes the rules a person's answers made, one rule write at a time, and
/// ends a session's session rules once it closes. Shared by `Arc`.
pub struct ApprovalRules {
    /// The pool every read borrows a connection from.
    reads: Arc<DatabaseReadPool>,
    /// Where the rule events are appended.
    events: Arc<SessionEventAppender>,
    /// The machine whose providers keep the rules made here.
    machine_id: MachineId,
    /// Takes a revoked rule out of force at one session's provider.
    revoke_at_provider: RevokeAtProvider,
    /// The daemon-wide bound an ask's command line is read under.
    shell_lines: Arc<ShellLineReadingBound>,
    /// Held by every rule write, so they land one at a time.
    rule_writes: KeyedLock<()>,
    /// Closed sessions whose session rules the ending task has yet to end.
    closed_sessions: PendingSessions,
}

impl ApprovalRules {
    /// The rules of `machine_id`'s providers, read through `reads`, recorded through `events`,
    /// taken out of force through `revoke_at_provider`, an ask's command line read under
    /// `shell_lines`; no session's rules end until [`ApprovalRules::start`].
    pub fn new(
        reads: Arc<DatabaseReadPool>,
        events: Arc<SessionEventAppender>,
        machine_id: MachineId,
        revoke_at_provider: RevokeAtProvider,
        shell_lines: Arc<ShellLineReadingBound>,
    ) -> Self {
        Self {
            reads,
            events,
            machine_id,
            revoke_at_provider,
            shell_lines,
            rule_writes: KeyedLock::new(),
            closed_sessions: PendingSessions::default(),
        }
    }

    /// The rule in force on the session over `subject` for an action of kind `action`, among the
    /// rules the daemon keeps alone when `is_daemon_kept` and else among those its providers keep,
    /// or `None` when none is; a block over the subject outranks an allow. Fails as the read fails.
    pub(crate) async fn find_rule(
        &self,
        session_id: SessionId,
        action: ProviderAskActionKind,
        subject: &str,
        is_daemon_kept: bool,
    ) -> Result<Option<ProviderAskRule>, ApprovalRuleError> {
        let mut in_force = self
            .read_rule_rows(&SELECT_RULES_IN_FORCE_SQL, session_id)
            .await?;
        in_force.retain(|row| row.is_daemon_kept == is_daemon_kept);
        Ok(rule_over(&in_force, action, subject))
    }

    /// The rules in force on the session, as the inspector lists them, oldest first, read with the
    /// session's existence in one read. Refuses `session.notFound` for a session the daemon does
    /// not hold; fails as the read fails.
    pub async fn list(
        &self,
        session_id: SessionId,
    ) -> Result<ApprovalRuleListResponse, ApprovalRuleError> {
        let rows = self
            .read(move |connection| {
                if !session_exists(connection, &session_id)? {
                    return Ok(None);
                }
                query_rule_rows(connection, &SELECT_RULES_IN_FORCE_SQL, session_id).map(Some)
            })
            .await?
            .ok_or_else(|| session_not_found(&session_id))?;
        Ok(ApprovalRuleListResponse {
            rules: rows
                .into_iter()
                .map(|row| RememberedRule {
                    rule_id: row.rule_id,
                    category: row.category,
                    scope: row.remembered_scope,
                    granted_at: row.granted_at,
                })
                .collect(),
        })
    }

    /// The working folders of the session's project a project rule is written into, each live
    /// worktree's own, or with `includes_archived` those of archived workspaces too; none for a
    /// chat. Fails as the read fails.
    pub(crate) async fn read_project_folders(
        &self,
        session_id: SessionId,
        includes_archived: bool,
    ) -> Result<Vec<PathBuf>, ApprovalRuleError> {
        self.read(move |connection| {
            connection
                .prepare_cached(&SELECT_PROJECT_FOLDERS_SQL)?
                .query_map(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@includes_archived": includes_archived,
                    },
                    |row| row.get::<_, String>(0).map(PathBuf::from),
                )?
                .collect()
        })
        .await
    }

    /// Records the rule an answer to `request` made, once its provider kept it, then revokes the
    /// rules it replaces, out of the project's files first for a project one, and hands every
    /// session those reached its rules again; a rule on a card the daemon raised itself replaces
    /// only the daemon's own and reaches no provider. A record that fails takes the rule back out
    /// of the providers and fails with [`ApprovalRuleError::NotRecorded`], or fails as it did for a
    /// rule the daemon keeps; a replaced rule's removal or revoke that fails fails with the new
    /// rule recorded. A card whose rule was ever recorded, revoked since or not, records nothing.
    pub(crate) async fn record(
        &self,
        request: &StoredApprovalRequest,
        made: &ProviderAnswerRule,
    ) -> Result<(), ApprovalRuleError> {
        let hold = self.rule_writes.acquire(()).await;
        // The card's rule was recorded before: an answer sent again records it once, and never
        // again once revoked, where it would replace a newer rule the person made.
        let rule_id = rule_id_of(request.approval_request_id);
        if self
            .read(move |connection| read_rule(connection, rule_id))
            .await?
            .is_some()
        {
            return Ok(());
        }
        let rule = &made.rule;
        let is_daemon_kept = request.ask_id.is_none();
        let in_force = self
            .read_rule_rows(&SELECT_RULES_IN_FORCE_SQL, request.session_id)
            .await?;
        let replaced_rows: Vec<RuleRow> = in_force
            .into_iter()
            .filter(|row| {
                let standing = provider_rule_of(row);
                row.is_daemon_kept == is_daemon_kept
                    && standing.kind == rule.kind
                    && stands_over_one_subject(&standing, rule)
            })
            .collect();
        if let Err(record_failure) = self.record_remembered(&hold, request, rule).await {
            if is_daemon_kept {
                return Err(record_failure);
            }
            return Err(self
                .take_back_unrecorded(&hold, request.session_id, rule, record_failure)
                .await);
        }
        let mut replaced = Vec::with_capacity(replaced_rows.len());
        for row in replaced_rows {
            let replaced_rule = provider_rule_of(&row);
            self.remove_from_project_files(&hold, row.session_id, &replaced_rule)
                .await?;
            let payload = revoked_payload(&row, InvalidationTrigger::Explicit, Some(request));
            self.record_revoked(&hold, payload).await?;
            replaced.push(replaced_rule);
        }
        if is_daemon_kept {
            return Ok(());
        }
        self.hand_out_rules(&hold, request.session_id, &replaced)
            .await
    }

    /// Revokes one rule where its provider keeps it, then records the revoke; a rule the daemon
    /// keeps alone is only recorded revoked. Refuses `approval.rule.notFound` for a rule never
    /// made, `approval.rule.alreadyRevoked` for one no longer in force, and
    /// `approval.rule.notKept` when a provider could not take a project rule out of a rule file,
    /// the rule left in force and nothing recorded. Fails with [`ApprovalRuleError::Provider`]
    /// when a provider could not read a session's rules again once the revoke was recorded.
    pub async fn revoke(
        &self,
        rule_id: RememberedRuleId,
    ) -> Result<ApprovalRuleRevokeResponse, ApprovalRuleError> {
        let hold = self.rule_writes.acquire(()).await;
        let found = self
            .read(move |connection| read_rule(connection, rule_id))
            .await?;
        let Some((row, is_in_force)) = found else {
            return Err(approval_rule_not_found(rule_id).into());
        };
        if !is_in_force {
            return Err(approval_rule_already_revoked(rule_id).into());
        }
        let rule = provider_rule_of(&row);
        self.remove_from_project_files(&hold, row.session_id, &rule)
            .await
            .map_err(|failure| match failure {
                ApprovalRuleError::Provider(cause) => {
                    approval_rule_revoke_not_kept(rule_id, cause).into()
                }
                unchanged @ (ApprovalRuleError::Refused(_)
                | ApprovalRuleError::Database(_)
                | ApprovalRuleError::Pool(_)
                | ApprovalRuleError::EmptySubject
                | ApprovalRuleError::Draft(_)
                | ApprovalRuleError::Append(_)
                | ApprovalRuleError::LineReading(_)
                | ApprovalRuleError::NotRecorded(_)) => unchanged,
            })?;
        let payload = revoked_payload(&row, InvalidationTrigger::Explicit, None);
        let revoked_at = self.record_revoked(&hold, payload).await?;
        if !row.is_daemon_kept {
            self.hand_out_rules(&hold, row.session_id, slice::from_ref(&rule))
                .await?;
        }
        Ok(ApprovalRuleRevokeResponse {
            rule_id,
            revoked_at,
            invalidation_trigger: ExplicitInvalidation::Value,
        })
    }

    /// Takes the project rules `session_id` made out of every working folder of its project before
    /// its purge, and answers what [`ApprovalRules::hand_out_after_purge`] gives each other
    /// session of the project once the purge has deleted the rules' records. Fails as a read or a
    /// removal fails.
    pub async fn withdraw_project_rules(
        &self,
        session_id: SessionId,
    ) -> Result<WithdrawnProjectRules, ApprovalRuleError> {
        let hold = self.rule_writes.acquire(()).await;
        let own = self
            .read_rule_rows(&SELECT_OWN_RULES_SQL, session_id)
            .await?;
        let rules: Vec<ProviderAskRule> = own
            .iter()
            .filter(|row| is_project_rule(row))
            .map(provider_rule_of)
            .collect();
        for rule in &rules {
            self.remove_from_project_files(&hold, session_id, rule)
                .await?;
        }
        let other_sessions = self
            .read_project_sessions(session_id)
            .await?
            .into_iter()
            .filter(|id| *id != session_id)
            .collect();
        Ok(WithdrawnProjectRules {
            rules,
            other_sessions,
        })
    }

    /// Hands each other session of a purged session's project its rules again, each provider
    /// reading them without the withdrawn ones. Fails with the first provider's failure.
    pub async fn hand_out_after_purge(
        &self,
        withdrawn: WithdrawnProjectRules,
    ) -> Result<(), ApprovalRuleError> {
        for other_session_id in withdrawn.other_sessions {
            for rule in &withdrawn.rules {
                self.revoke_at(other_session_id, rule, None).await?;
            }
        }
        Ok(())
    }

    // Hands every session `rules` reached from `session_id` its rules again, each provider reading
    // them without the ones no longer in force.
    async fn hand_out_rules(
        &self,
        _hold: &RuleWriteHold<'_>,
        session_id: SessionId,
        rules: &[ProviderAskRule],
    ) -> Result<(), ApprovalRuleError> {
        for rule in rules {
            let reached = match rule.kind {
                RememberedScopeKind::Project => self.read_project_sessions(session_id).await?,
                RememberedScopeKind::Session => vec![session_id],
            };
            for reached_session_id in reached {
                self.revoke_at(reached_session_id, rule, None).await?;
            }
        }
        Ok(())
    }

    // A project rule lives in the files of every working folder of its project, those of archived
    // workspaces among them where the folder stayed; a session rule lives in no file.
    async fn remove_from_project_files(
        &self,
        _hold: &RuleWriteHold<'_>,
        maker_session_id: SessionId,
        rule: &ProviderAskRule,
    ) -> Result<(), ApprovalRuleError> {
        match rule.kind {
            RememberedScopeKind::Session => Ok(()),
            RememberedScopeKind::Project => {
                for folder in self.read_project_folders(maker_session_id, true).await? {
                    self.revoke_at(maker_session_id, rule, Some(folder)).await?;
                }
                Ok(())
            }
        }
    }

    // Takes a rule its record failed to keep back out of the providers that kept it, and answers
    // the record's failure, with the take-back's beside it when that failed too.
    async fn take_back_unrecorded(
        &self,
        hold: &RuleWriteHold<'_>,
        session_id: SessionId,
        rule: &ProviderAskRule,
        record_failure: ApprovalRuleError,
    ) -> ApprovalRuleError {
        let take_back = async {
            self.remove_from_project_files(hold, session_id, rule)
                .await?;
            self.hand_out_rules(hold, session_id, slice::from_ref(rule))
                .await
        };
        let take_back_failures = match take_back.await {
            Ok(()) => Vec::new(),
            Err(take_back_failure) => vec![take_back_failure],
        };
        ApprovalRuleError::NotRecorded(Box::new(CleanupFailures::new(
            record_failure,
            take_back_failures,
            "recording the rule",
        )))
    }

    // Writes the rule's event with its remembered scope on the ask's answer, in one write.
    async fn record_remembered(
        &self,
        _hold: &RuleWriteHold<'_>,
        request: &StoredApprovalRequest,
        rule: &ProviderAskRule,
    ) -> Result<(), ApprovalRuleError> {
        let pattern =
            NonEmptyText::new(rule.subject.clone()).ok_or(ApprovalRuleError::EmptySubject)?;
        let remembered_scope = RememberedScope {
            kind: rule.kind,
            pattern,
            sense: rule.sense,
        };
        let remembered_scope_write =
            remembered_scope_statement(&request.approval_request_id, &remembered_scope);
        let payload = ApprovalRuleRememberedPayload {
            session_id: request.session_id,
            run_id: request.run_id,
            approval_request_id: request.approval_request_id,
            category: request.category,
            scope: request.scope.clone(),
            machine_id: self.machine_id.clone(),
            rule_id: rule_id_of(request.approval_request_id),
            remembered_scope,
        };
        let draft = SessionEventDraft::new(payload, SessionEvent::ApprovalRuleRemembered)?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(WireInstant::now()),
            transactional_prelude: vec![remembered_scope_write],
            ..SessionEventLinkage::default()
        };
        self.events.append(draft, linkage).await?;
        Ok(())
    }

    // Records one revoke and answers its instant.
    async fn record_revoked(
        &self,
        _hold: &RuleWriteHold<'_>,
        payload: ApprovalRuleRevokedPayload,
    ) -> Result<WireInstant, ApprovalRuleError> {
        let revoked_at = WireInstant::now();
        let draft = SessionEventDraft::new(payload, SessionEvent::ApprovalRuleRevoked)?;
        let linkage = SessionEventLinkage {
            occurred_at: Some(revoked_at.clone()),
            ..SessionEventLinkage::default()
        };
        self.events.append(draft, linkage).await?;
        Ok(revoked_at)
    }

    async fn revoke_at(
        &self,
        session_id: SessionId,
        rule: &ProviderAskRule,
        project_folder: Option<PathBuf>,
    ) -> Result<(), ApprovalRuleError> {
        (self.revoke_at_provider)(RevokeRuleParams {
            session_id,
            rule: rule.clone(),
            project_folder,
        })
        .await
        .map_err(ApprovalRuleError::Provider)
    }

    async fn read_rule_rows(
        &self,
        sql: &'static LazyLock<String>,
        session_id: SessionId,
    ) -> Result<Vec<RuleRow>, ApprovalRuleError> {
        self.read(move |connection| query_rule_rows(connection, sql, session_id))
            .await
    }

    async fn read_project_sessions(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<SessionId>, ApprovalRuleError> {
        self.read(move |connection| {
            connection
                .prepare_cached(&SELECT_PROJECT_SESSIONS_SQL)?
                .query_map(
                    named_params! { "@session_id": session_id.text().as_str() },
                    session_id_of,
                )?
                .collect()
        })
        .await
    }

    // Every read here is of a few rows.
    async fn read<Output: Send + 'static>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<Output> + Send + 'static,
    ) -> Result<Output, ApprovalRuleError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ApprovalRuleError>(read(connection)?)
            })
            .await
    }
}

fn is_project_rule(row: &RuleRow) -> bool {
    row.remembered_scope.kind == RememberedScopeKind::Project
}

// The revoke of `row`'s rule, naming the ask in flight that replaced it, if any.
fn revoked_payload(
    row: &RuleRow,
    invalidation_trigger: InvalidationTrigger,
    replacing: Option<&StoredApprovalRequest>,
) -> ApprovalRuleRevokedPayload {
    ApprovalRuleRevokedPayload {
        session_id: row.session_id,
        category: row.category,
        scope: row.scope.clone(),
        rule_id: row.rule_id,
        invalidation_trigger,
        run_id: replacing.map(|request| request.run_id),
        approval_request_id: replacing.map(|request| request.approval_request_id),
    }
}

// The rule among `rules` over `subject` for an action of kind `action`; a block outranks an allow.
fn rule_over(
    rules: &[RuleRow],
    action: ProviderAskActionKind,
    subject: &str,
) -> Option<ProviderAskRule> {
    let mut matching = rules
        .iter()
        .map(provider_rule_of)
        .filter(|rule| rule.action == action && rule.subject == subject);
    let first = matching.next()?;
    match first.sense {
        RememberedRuleSense::Block => Some(first),
        RememberedRuleSense::Allow => Some(
            matching
                .find(|rule| rule.sense == RememberedRuleSense::Block)
                .unwrap_or(first),
        ),
    }
}

// Two rules stand over one subject when they name the same action and subject, whatever their
// sense.
fn stands_over_one_subject(left: &ProviderAskRule, right: &ProviderAskRule) -> bool {
    left.action == right.action && left.subject == right.subject
}

fn provider_rule_of(row: &RuleRow) -> ProviderAskRule {
    ProviderAskRule {
        kind: row.remembered_scope.kind,
        sense: row.remembered_scope.sense,
        action: row.action,
        subject: row.remembered_scope.pattern.as_str().to_owned(),
    }
}

// A rule's id is the id of the ask that made it.
fn rule_id_of(approval_request_id: ApprovalRequestId) -> RememberedRuleId {
    RememberedRuleId::new(approval_request_id.text().as_str())
        .expect("an ask's id is a UUID, as a rule's id is")
}

fn query_rule_rows(
    connection: &Connection,
    sql: &LazyLock<String>,
    session_id: SessionId,
) -> rusqlite::Result<Vec<RuleRow>> {
    connection
        .prepare_cached(sql)?
        .query_map(
            named_params! { "@session_id": session_id.text().as_str() },
            rule_row_of,
        )?
        .collect()
}

fn read_rule(
    connection: &Connection,
    rule_id: RememberedRuleId,
) -> rusqlite::Result<Option<(RuleRow, bool)>> {
    connection
        .prepare_cached(&SELECT_RULE_SQL)?
        .query_row(
            named_params! { "@rule_id": rule_id.text().as_str() },
            |row| Ok((rule_row_of(row)?, row.get::<_, bool>(8)?)),
        )
        .optional()
}

fn session_id_of(row: &Row<'_>) -> rusqlite::Result<SessionId> {
    text_column(row, 0, |text| SessionId::new(&text))
}

// Reads the columns `RULE_SELECT_LIST_SQL` selects, in its order.
fn rule_row_of(row: &Row<'_>) -> rusqlite::Result<RuleRow> {
    let action: ProviderAskAction = text_column(row, 3, |text| serde_json::from_str(&text))?;
    Ok(RuleRow {
        session_id: session_id_of(row)?,
        rule_id: text_column(row, 1, |text| RememberedRuleId::new(&text))?,
        remembered_scope: text_column(row, 2, |text| serde_json::from_str(&text))?,
        action: ProviderAskActionKind::from(&action),
        category: text_column(row, 4, closed_word)?,
        scope: text_column(row, 5, ApprovalScope::new)?,
        granted_at: text_column(row, 6, WireInstant::try_from)?,
        is_daemon_kept: row.get(7)?,
    })
}

#[cfg(test)]
mod tests;
