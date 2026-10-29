//! The gate: whether an entry raises a banner and a web-address message, decided once per entry,
//! and again for a handed-back wait's banner, from the machine's notification settings as the file
//! stands, the session's mute, whether the entry has already resolved and whether an app window is
//! in front on any device, and the one write that records a batch of decisions. A switch or a mute
//! only withholds a channel; the entry stays in the list and the count.

use std::error::Error;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::attention::{
    AttentionBannerState, AttentionTrigger, AttentionWebAddressState,
};
use sidekicks_contracts::machine::settings::{NotificationKindSwitches, NotificationSettings};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_store::database::statement::{WriteStatement, nullable_text_binding, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::machine_settings::MachineSettingsReader;

use crate::attention::projection::{session_binding, statement, version_bump_sql};

// The bump of a decided session's counts, while it still has entries: a session purged since its
// entries were read gets no decision row, and no count row either.
static BUMP_IF_SESSION_HAS_ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql("EXISTS (SELECT 1 FROM attention_entries WHERE session_id = @session_id)")
});

// Inserts an entry's decision, or decides again a banner handed back undecided, which touches only
// the banner and its merge so the web address stays decided once. An entry deleted since it was
// read gets no row. A session muted since the decision read its mute withholds its end's banner
// and web-address message here, in the write itself, since the mute's own write found no row to
// withdraw.
static WRITE_DECISION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO attention_deliveries
  (entry_id, banner_state, merged_into, web_address_state, web_address_attempt_count,
   muted_at_decision)
  SELECT entry.id,
         CASE WHEN {muted_end} THEN '{withheld}' ELSE @banner_state END,
         @merged_into,
         CASE WHEN {muted_end} THEN NULL ELSE @web_address_state END,
         CASE WHEN {muted_end} THEN NULL ELSE @web_address_attempt_count END,
         COALESCE(@muted_at_decision, session_row.muted_at)
    FROM attention_entries AS entry
    LEFT JOIN sessions AS session_row ON session_row.id = entry.session_id
   WHERE entry.id = @entry_id
  ON CONFLICT (entry_id) DO UPDATE
    SET banner_state = excluded.banner_state, merged_into = excluded.merged_into
    WHERE attention_deliveries.banner_state IS NULL",
        muted_end = format!(
            "session_row.muted_at IS NOT NULL AND entry.trigger IN ('{completed}', '{failed}')",
            completed = <&'static str>::from(AttentionTrigger::RunCompleted),
            failed = <&'static str>::from(AttentionTrigger::RunFailed),
        ),
        withheld = <&'static str>::from(AttentionBannerState::Withheld),
    )
});

static PENDING_WEB_ADDRESS_STATE: LazyLock<&'static str> =
    LazyLock::new(|| <&'static str>::from(AttentionWebAddressState::Pending));

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
        && is_kind_on(settings.kinds, trigger)
        && !is_muted_end
        && !is_resolved;
    let is_web_address_sent = settings.web_address.enabled
        && is_kind_on(settings.web_address.kinds, trigger)
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

/// Records `decisions` in one write, raising the machine's change count and each decided session's
/// that still has entries.
pub(crate) async fn write_decisions(
    writer: &DatabaseWriter,
    decisions: &[DeliveryDecision],
) -> Result<(), WriteError> {
    let bumps = decided_sessions(decisions).into_iter().map(|session_id| {
        statement(
            &BUMP_IF_SESSION_HAS_ENTRIES_SQL,
            vec![session_binding(session_id)],
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

/// The sessions `decisions` decide entries of, each once, in the order they first appear.
pub(crate) fn decided_sessions(decisions: &[DeliveryDecision]) -> Vec<SessionId> {
    let mut sessions: Vec<SessionId> = Vec::new();
    for decided in decisions {
        if !sessions.contains(&decided.session_id) {
            sessions.push(decided.session_id);
        }
    }
    sessions
}

fn decision_statement(decided: &DeliveryDecision) -> WriteStatement {
    let (web_address_state, web_address_attempt_count) = if decided.decision.is_web_address_sent {
        (
            Value::Text((*PENDING_WEB_ADDRESS_STATE).to_owned()),
            Value::Integer(0),
        )
    } else {
        (Value::Null, Value::Null)
    };
    statement(
        &WRITE_DECISION_SQL,
        vec![
            text_binding("@entry_id", &decided.entry_id),
            text_binding(
                "@banner_state",
                <&'static str>::from(decided.decision.banner_state),
            ),
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

// Whether `kinds` lets `trigger`'s kind through. A provider's build is no notification kind, so
// nothing lets it through.
fn is_kind_on(kinds: NotificationKindSwitches, trigger: AttentionTrigger) -> bool {
    match trigger {
        AttentionTrigger::PendingApproval | AttentionTrigger::PendingInput => kinds.waiting_on_you,
        AttentionTrigger::RunCompleted => kinds.finished,
        AttentionTrigger::RunFailed => kinds.failed,
        AttentionTrigger::WorkflowNotify => kinds.notify_step,
        AttentionTrigger::ProviderBuild => false,
    }
}

#[cfg(test)]
mod tests;
