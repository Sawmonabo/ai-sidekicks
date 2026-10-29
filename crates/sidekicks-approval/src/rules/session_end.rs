//! A session's end ends its session rules: a follower of every session hands each committed close
//! to one task, which revokes the session's session rules in force, and a start ends those of
//! sessions that closed with their rules still in force. Its project rules stand until its purge.

use std::error::Error;
use std::sync::{Arc, LazyLock};

use sidekicks_contracts::approval::events::ApprovalRuleRevokedPayload;
use sidekicks_contracts::approval::{InvalidationTrigger, RememberedScopeKind};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_session::directory::lookups::ENDED_SESSION_STATES_SQL;
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{
    ApprovalRuleError, ApprovalRules, NOT_REVOKED_SQL, RULE_SOURCE_SQL, RuleRow,
    SELECT_OWN_RULES_SQL, is_project_rule, revoked_payload, session_id_of,
};

// The ended sessions that still hold a session rule in force, which a start ends.
static SELECT_ENDED_SESSIONS_WITH_RULES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT remembered.session_id AS id
  {}
    AND json_extract(remembered.payload, '$.rememberedScope.kind') = '{}'
    AND remembered.session_id IN (SELECT id FROM sessions WHERE state IN ({}))
    AND {}",
        *RULE_SOURCE_SQL,
        <&'static str>::from(RememberedScopeKind::Session),
        *ENDED_SESSION_STATES_SQL,
        *NOT_REVOKED_SQL
    )
});

/// The task that ends closed sessions' session rules and its follower of closes, from
/// [`ApprovalRules::start`] until [`SessionRuleEnding::stop`].
pub struct SessionRuleEnding {
    /// Hears every committed close; dropping it detaches.
    attachment: FollowerAttachment,
    /// Ends the task after the ends under way.
    stop: CancellationToken,
    /// The task that ends the rules.
    task: JoinHandle<()>,
}

impl SessionRuleEnding {
    /// Stops hearing closes and settles once the ends under way are done. Fails only when the task
    /// itself ended abnormally.
    pub async fn stop(self) -> Result<(), JoinError> {
        let Self {
            attachment,
            stop,
            task,
        } = self;
        drop(attachment);
        stop.cancel();
        task.await
    }
}

impl ApprovalRules {
    /// Follows `followers` to end the session rules of every session that closes, and ends those
    /// of sessions that closed with their rules still in force, both until the returned handle's
    /// stop.
    pub fn start(self: &Arc<Self>, followers: &Arc<SessionEventFollowers>) -> SessionRuleEnding {
        let rules = Arc::clone(self);
        // Runs on the writer's pump, so it only names the session for the task.
        let attachment = followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::SessionClosed {
                rules.closed_sessions.add(event.envelope.session_id());
            }
            Ok(())
        });
        let stop = CancellationToken::new();
        let task = tokio::spawn(end_closed_sessions_until_stopped(
            Arc::clone(self),
            stop.clone(),
        ));
        SessionRuleEnding {
            attachment,
            stop,
            task,
        }
    }

    // Revokes the closed session's session rules; its project rules stand until its purge.
    async fn end_session_rules(&self, session_id: SessionId) -> Result<(), ApprovalRuleError> {
        let hold = self.rule_writes.acquire(()).await;
        let own = self
            .read_rule_rows(&SELECT_OWN_RULES_SQL, session_id)
            .await?;
        for payload in session_end_revocations(&own) {
            self.record_revoked(&hold, payload).await?;
        }
        Ok(())
    }

    async fn read_ended_sessions_with_rules(&self) -> Result<Vec<SessionId>, ApprovalRuleError> {
        self.read(|connection| {
            connection
                .prepare_cached(&SELECT_ENDED_SESSIONS_WITH_RULES_SQL)?
                .query_map([], session_id_of)?
                .collect()
        })
        .await
    }
}

// No caller waits on an end, so a failed one is logged; the next start's sweep ends the session's
// rules still in force. A stop lets the batch under way finish.
async fn end_closed_sessions_until_stopped(rules: Arc<ApprovalRules>, stop: CancellationToken) {
    match rules.read_ended_sessions_with_rules().await {
        Ok(ended) => {
            for session_id in ended {
                rules.closed_sessions.add(session_id);
            }
        }
        Err(error) => tracing::error!(
            error = &error as &(dyn Error + 'static),
            "approval_session_rules_sweep_failed"
        ),
    }
    loop {
        let closed = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            closed = rules.closed_sessions.take() => closed,
        };
        for session_id in closed {
            if let Err(error) = rules.end_session_rules(session_id).await {
                tracing::error!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "approval_session_rules_end_failed"
                );
            }
        }
    }
}

// The revokes a session's end records among its own rules in force: each session rule, with the
// session's end as its trigger; its project rules stand.
fn session_end_revocations(own_rules: &[RuleRow]) -> Vec<ApprovalRuleRevokedPayload> {
    own_rules
        .iter()
        .filter(|row| !is_project_rule(row))
        .map(|row| revoked_payload(row, InvalidationTrigger::SessionEnd, None))
        .collect()
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::approval::{
        ApprovalCategory, ApprovalRequestId, ApprovalScope, ApprovalState, InvalidationTrigger,
        RememberedRuleId, RememberedRuleSense, RememberedScope, RememberedScopeKind,
    };
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
    use sidekicks_policy::ask_rule::ProviderAskActionKind;

    use super::{RuleRow, revoked_payload, session_end_revocations};
    use crate::request_create::ApprovalResourceDescriptor;
    use crate::store::StoredApprovalRequest;

    const SESSION: &str = "0190a5a0-0000-7000-8000-000000000001";

    fn rule_row(rule_id: &str, kind: RememberedScopeKind) -> RuleRow {
        RuleRow {
            session_id: SessionId::new(SESSION).expect("a session id"),
            rule_id: RememberedRuleId::new(rule_id).expect("a rule id"),
            remembered_scope: RememberedScope {
                kind,
                pattern: NonEmptyText::new("npm run".to_owned()).expect("a subject"),
                sense: RememberedRuleSense::Allow,
            },
            action: ProviderAskActionKind::Command,
            category: ApprovalCategory::ToolExecution,
            scope: ApprovalScope::new("npm run build".to_owned()).expect("a scope"),
            granted_at: WireInstant::try_from("2026-10-18T09:00:00.000Z".to_owned())
                .expect("an instant"),
            is_daemon_kept: false,
        }
    }

    #[test]
    fn a_session_end_revokes_its_session_rules_and_leaves_its_project_rules_standing() {
        let session_rule = "0190a5a0-0000-7000-8000-00000000000a";
        let project_rule = "0190a5a0-0000-7000-8000-00000000000b";
        let own_rules = [
            rule_row(session_rule, RememberedScopeKind::Session),
            rule_row(project_rule, RememberedScopeKind::Project),
        ];

        let revoked = session_end_revocations(&own_rules);

        assert_eq!(revoked.len(), 1);
        assert_eq!(revoked[0].rule_id.text().as_str(), session_rule);
        assert_eq!(
            revoked[0].invalidation_trigger,
            InvalidationTrigger::SessionEnd
        );
        assert_eq!(revoked[0].run_id, None);
    }

    // The ask whose answer made a rule that replaces a standing one.
    fn replacing_ask(approval_request_id: &str, run_id: &str) -> StoredApprovalRequest {
        let at = WireInstant::try_from("2026-10-18T09:30:00.000Z".to_owned()).expect("an instant");
        StoredApprovalRequest {
            approval_request_id: ApprovalRequestId::new(approval_request_id).expect("an ask id"),
            session_id: SessionId::new(SESSION).expect("a session id"),
            run_id: RunId::new(run_id).expect("a run id"),
            requested_by: NonEmptyText::new("agent".to_owned()).expect("an actor"),
            category: ApprovalCategory::ToolExecution,
            scope: ApprovalScope::new("npm run test".to_owned()).expect("a scope"),
            resource_descriptor: ApprovalResourceDescriptor {
                subject: FreeFormText::new("npm run".to_owned()).expect("a subject"),
                standing_allow_offered: true,
                project_scope_offered: false,
                editable: false,
                action: None,
                tool_name: None,
                prompt: None,
            },
            ask_id: None,
            tool_call_id: None,
            state: ApprovalState::Approved,
            created_at: at.clone(),
            updated_at: at,
            standing_allow_offered: true,
            project_scope_offered: false,
            resolution: None,
        }
    }

    #[test]
    fn a_replaced_rule_s_revoke_names_the_ask_that_replaced_it() {
        let replaced_rule = "0190a5a0-0000-7000-8000-00000000000a";
        let ask = "0190a5a0-0000-7000-8000-00000000000c";
        let run = "0190a5a0-0000-7000-8000-00000000000d";
        let row = rule_row(replaced_rule, RememberedScopeKind::Session);

        let revoked = revoked_payload(
            &row,
            InvalidationTrigger::Explicit,
            Some(&replacing_ask(ask, run)),
        );

        assert_eq!(revoked.rule_id.text().as_str(), replaced_rule);
        assert_eq!(revoked.invalidation_trigger, InvalidationTrigger::Explicit);
        assert_eq!(
            revoked
                .approval_request_id
                .map(|id| id.text().as_str().to_owned()),
            Some(ask.to_owned())
        );
        assert_eq!(
            revoked.run_id.map(|id| id.text().as_str().to_owned()),
            Some(run.to_owned())
        );
    }
}
