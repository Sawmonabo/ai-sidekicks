//! The gate: whether an entry raises a banner and a web-address message, decided once from the
//! machine's notification settings as the file stands, the session's mute, whether the entry has
//! already resolved and whether an app window is in front on any device, and the one write that
//! records a batch of decisions. A switch or a mute only withholds a channel; the entry stays in
//! the list and the count.

use std::error::Error;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::attention::{
    AttentionBannerState, AttentionTrigger, AttentionWebAddressState,
};
use sidekicks_contracts::machine::settings::{NotificationKindSwitches, NotificationSettings};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::machine_settings::MachineSettingsReader;

use crate::attention::projection::BUMP_ALWAYS_SQL;
use crate::attention::schema::word_of;

// Inserts an entry's decision, or decides again a banner handed back undecided, which touches only
// the banner and its merge so the web address stays decided once. An entry deleted since it was
// read gets no row.
const WRITE_DECISION_SQL: &str = "INSERT INTO attention_deliveries
  (entry_id, banner_state, merged_into, web_address_state, web_address_attempt_count,
   muted_at_decision)
  SELECT @entry_id, @banner_state, @merged_into, @web_address_state, @web_address_attempt_count,
         @muted_at_decision
   WHERE EXISTS (SELECT 1 FROM attention_entries WHERE id = @entry_id)
  ON CONFLICT (entry_id) DO UPDATE
    SET banner_state = excluded.banner_state, merged_into = excluded.merged_into
    WHERE attention_deliveries.banner_state IS NULL";

static PENDING_WEB_ADDRESS_STATE: LazyLock<String> =
    LazyLock::new(|| word_of(AttentionWebAddressState::Pending));

/// What the gate decides for one entry's channels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    /// `pending` for main to post, or `withheld`.
    pub(crate) banner_state: AttentionBannerState,
    /// Whether a message goes to the web address, which then starts `pending` with no attempt.
    pub(crate) is_web_address_sent: bool,
}

/// One entry's decision as the batch write records it.
#[derive(Clone, Debug)]
pub(crate) struct DeliveryDecision {
    /// The entry decided.
    pub(crate) entry_id: String,
    /// Its session, whose change count the write raises.
    pub(crate) session_id: SessionId,
    /// What the gate decided.
    pub(crate) decision: Decision,
    /// The entry whose banner this one's merged into, which then reads `withheld`.
    pub(crate) merged_into: Option<String>,
    /// The session's mute as the decision read it, in the stored form; `None` while unmuted.
    pub(crate) muted_at: Option<String>,
}

/// The notification settings as the machine's file stands, or `None` when the file cannot be
/// read, which withholds every channel of the decisions that read it; the failure is logged.
pub(crate) async fn read_notification_settings(
    settings: &dyn MachineSettingsReader,
) -> Option<NotificationSettings> {
    match settings.read_machine_settings().await {
        Ok(settings) => Some(settings.notifications),
        Err(error) => {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                "the machine's settings were not read, so the attention entries decided now are \
                 withheld from every channel"
            );
            None
        }
    }
}

/// Decides an entry raised by `trigger`. The banner is withheld with no settings, with the master
/// switch or the kind's switch off, for a muted session's `Finished` or `Failed`, and for an entry
/// already resolved. The web address is sent under its own switch and kinds, never for a muted
/// end or a resolved entry, and only while no app window is in front unless it is a Notify step.
pub(crate) fn decide(
    settings: Option<&NotificationSettings>,
    trigger: AttentionTrigger,
    is_muted: bool,
    is_resolved: bool,
    is_app_in_front: bool,
) -> Decision {
    let Some(settings) = settings else {
        return Decision {
            banner_state: AttentionBannerState::Withheld,
            is_web_address_sent: false,
        };
    };
    let is_muted_end = is_muted
        && matches!(
            trigger,
            AttentionTrigger::RunCompleted | AttentionTrigger::RunFailed
        );
    let is_banner_raised = settings.notify_outside_app
        && is_kind_on(&settings.kinds, trigger)
        && !is_muted_end
        && !is_resolved;
    let is_web_address_sent = settings.web_address.enabled
        && is_kind_on(&settings.web_address.kinds, trigger)
        && !is_muted_end
        && !is_resolved
        && (!is_app_in_front || trigger == AttentionTrigger::WorkflowNotify);
    Decision {
        banner_state: if is_banner_raised {
            AttentionBannerState::Pending
        } else {
            AttentionBannerState::Withheld
        },
        is_web_address_sent,
    }
}

/// Records `decisions` in one write, raising the machine's change count and each decided session's.
pub(crate) async fn write_decisions(
    writer: &DatabaseWriter,
    decisions: &[DeliveryDecision],
) -> Result<(), WriteError> {
    let mut sessions: Vec<SessionId> = Vec::new();
    for decided in decisions {
        if !sessions.contains(&decided.session_id) {
            sessions.push(decided.session_id);
        }
    }
    let bumps = sessions.iter().map(|session_id| {
        statement(
            &BUMP_ALWAYS_SQL,
            vec![text_binding("@session_id", &session_id.to_string())],
        )
    });
    let statements = decisions
        .iter()
        .map(decision_statement)
        .chain(bumps)
        .collect();
    writer.write(statements).await?;
    Ok(())
}

fn decision_statement(decided: &DeliveryDecision) -> WriteStatement {
    let (web_address_state, web_address_attempt_count) = if decided.decision.is_web_address_sent {
        (
            Value::Text(PENDING_WEB_ADDRESS_STATE.clone()),
            Value::Integer(0),
        )
    } else {
        (Value::Null, Value::Null)
    };
    statement(
        WRITE_DECISION_SQL,
        vec![
            text_binding("@entry_id", &decided.entry_id),
            text_binding("@banner_state", &word_of(decided.decision.banner_state)),
            nullable_text_binding("@merged_into", decided.merged_into.as_deref()),
            ("@web_address_state".into(), web_address_state),
            (
                "@web_address_attempt_count".into(),
                web_address_attempt_count,
            ),
            nullable_text_binding("@muted_at_decision", decided.muted_at.as_deref()),
        ],
    )
}

// Whether `kinds` lets `trigger`'s kind through.
fn is_kind_on(kinds: &NotificationKindSwitches, trigger: AttentionTrigger) -> bool {
    match trigger {
        AttentionTrigger::PendingApproval | AttentionTrigger::PendingInput => kinds.waiting_on_you,
        AttentionTrigger::RunCompleted => kinds.finished,
        AttentionTrigger::RunFailed => kinds.failed,
        AttentionTrigger::WorkflowNotify => kinds.notify_step,
    }
}

fn statement(
    sql: &'static str,
    bindings: Vec<(std::borrow::Cow<'static, str>, Value)>,
) -> WriteStatement {
    WriteStatement {
        sql: sql.into(),
        bindings: StatementBindings::Named(bindings),
        expected_row_count: None,
    }
}

#[cfg(test)]
mod tests;
