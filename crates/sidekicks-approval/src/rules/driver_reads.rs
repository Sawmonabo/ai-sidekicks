//! What a driver reads of the rules: the rules in force on a session, which it hands its
//! provider, and the revoked rule a provider that cannot drop one itself holds the next call on.

use std::error::Error;
use std::sync::LazyLock;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

use super::{
    ApprovalRuleError, ApprovalRules, NOT_REVOKED_SQL, RULE_SELECT_LIST_SQL, RULE_SOURCE_SQL,
    RuleRow, SELECT_RULES_IN_FORCE_SQL, provider_rule_of, query_rule_rows, rule_over,
};
use crate::ask_description::{derive_rule_subject, read_command_line};
use sidekicks_policy::ask_rule::{ProviderAskActionKind, ProviderAskRule};
use sidekicks_provider::port::permission_ask::ProviderAskAction;
use sidekicks_provider::port::session_rules::SessionRulePort;

// The rules made in a session and revoked since, oldest first.
static SELECT_REVOKED_IN_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {RULE_SELECT_LIST_SQL} {}
    AND remembered.session_id = @session_id
    AND NOT {}
  ORDER BY remembered.occurred_at, remembered.sequence",
        *RULE_SOURCE_SQL, *NOT_REVOKED_SQL
    )
});

impl SessionRulePort for ApprovalRules {
    fn read_session_rules(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Vec<ProviderAskRule>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let in_force = self
                .read_rule_rows(&SELECT_RULES_IN_FORCE_SQL, session_id)
                .await?;
            Ok(in_force
                .iter()
                .filter(|row| !row.is_daemon_kept)
                .map(provider_rule_of)
                .collect())
        })
    }

    fn find_revoked_rule(
        &self,
        session_id: SessionId,
        action: ProviderAskAction,
    ) -> BoxFuture<'_, Result<Option<ProviderAskRule>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let kind = ProviderAskActionKind::from(&action);
            let read_action = action.clone();
            let subject = read_command_line(&self.shell_lines, &action, move |reader, reading| {
                derive_rule_subject(reader, reading, &read_action)
            })
            .await
            .map_err(ApprovalRuleError::from)?;
            let Some(subject) = subject else {
                return Ok(None);
            };
            let (in_force, revoked) = self
                .read(move |connection| {
                    // One snapshot, so a rule revoked between the two reads is seen once.
                    let snapshot = connection.unchecked_transaction()?;
                    let in_force =
                        query_rule_rows(&snapshot, &SELECT_RULES_IN_FORCE_SQL, session_id)?;
                    let revoked =
                        query_rule_rows(&snapshot, &SELECT_REVOKED_IN_SESSION_SQL, session_id)?;
                    snapshot.commit()?;
                    // The providers hold none of the rules the daemon keeps alone.
                    let provider_kept = |rows: Vec<RuleRow>| -> Vec<RuleRow> {
                        rows.into_iter().filter(|row| !row.is_daemon_kept).collect()
                    };
                    Ok((provider_kept(in_force), provider_kept(revoked)))
                })
                .await?;
            if rule_over(&in_force, kind, &subject).is_some() {
                return Ok(None);
            }
            Ok(revoked
                .iter()
                .map(provider_rule_of)
                .find(|rule| rule.action == kind && rule.subject == subject))
        })
    }
}
