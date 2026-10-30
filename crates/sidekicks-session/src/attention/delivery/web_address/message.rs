//! The message a moment sends to the web address: one JSON object naming the session or run, its
//! state, the moment, when it happened, this machine and the link that opens it, built from the
//! entry's own name and state word and never from a word of a transcript. It is serialized once,
//! when its send is first written, and those bytes are signed and sent unchanged at every attempt.
//!
//! Its size is bounded by what it names: a session's, a workflow's and the machine's names at 256
//! code points each and a Notify step's notice at 2,000.

use rusqlite::Connection;
use serde::Serialize;
use sidekicks_contracts::app_link::{AppLinkTarget, compose_app_link};
use sidekicks_contracts::attention::{AttentionItem, AttentionMomentTrigger};

use crate::attention::read::{AttentionReadError, read_attention_entry};

/// What kind of moment a message announces.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum MessageKind {
    /// A wait on the person: an approval or an answer.
    WaitingOnYou,
    /// A run finished.
    Finished,
    /// A run failed.
    Failed,
    /// A workflow's Notify step.
    NotifyStep,
}

/// Whether the subject is a session or a workflow run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SubjectType {
    /// A session.
    Session,
    /// A workflow run.
    Run,
}

/// The session or run a message names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct MessageSubject {
    #[serde(rename = "type")]
    subject_type: SubjectType,
    id: String,
    name: String,
}

/// The body of one moment's message, in the order its members are sent. `content` repeats `text`
/// for a receiver that shows only that member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebAddressMessage {
    text: String,
    kind: MessageKind,
    state: String,
    subject: MessageSubject,
    moment_id: String,
    at: String,
    machine: String,
    link: String,
    content: String,
}

impl WebAddressMessage {
    /// The message of `item`, whose link opens `subject`, sent from the machine named `machine`;
    /// `None` for a provider's build, which no web address is sent.
    fn of_item(item: &AttentionItem, subject: &AppLinkTarget, machine: &str) -> Option<Self> {
        let (kind, name, state, moment_id, at) = match item {
            AttentionItem::Moment(moment) => {
                let kind = match moment.trigger {
                    AttentionMomentTrigger::PendingApproval
                    | AttentionMomentTrigger::PendingInput => MessageKind::WaitingOnYou,
                    AttentionMomentTrigger::RunCompleted => MessageKind::Finished,
                    AttentionMomentTrigger::RunFailed => MessageKind::Failed,
                };
                (
                    kind,
                    &moment.display_name,
                    &moment.state_word,
                    &moment.moment_id,
                    &moment.created_at,
                )
            }
            AttentionItem::Notify(notify) => (
                MessageKind::NotifyStep,
                &notify.display_name,
                &notify.state_word,
                &notify.moment_id,
                &notify.created_at,
            ),
            AttentionItem::ProviderBuild(_) => return None,
        };
        let (subject_type, id) = match subject {
            AppLinkTarget::Session { session_id } => (SubjectType::Session, session_id.text()),
            AppLinkTarget::WorkflowRun { workflow_run_id } => {
                (SubjectType::Run, workflow_run_id.text())
            }
        };
        let text = format!("{} · {}", name.as_str(), state.as_str());
        Some(Self {
            content: text.clone(),
            text,
            kind,
            state: state.as_str().to_owned(),
            subject: MessageSubject {
                subject_type,
                id: id.as_str().to_owned(),
                name: name.as_str().to_owned(),
            },
            moment_id: moment_id.as_str().to_owned(),
            at: at.as_str().to_owned(),
            machine: machine.to_owned(),
            link: compose_app_link(subject),
        })
    }

    fn to_body(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a message of text members serializes")
    }
}

/// The body of entry `entry_id`'s message, sent from the machine named `machine`, read on `reader`;
/// `None` when no entry has that id. Fails with [`AttentionReadError`] when the entry's read does.
pub(crate) fn read_message_body(
    reader: &Connection,
    entry_id: &str,
    machine: &str,
) -> Result<Option<Vec<u8>>, AttentionReadError> {
    Ok(
        read_attention_entry(reader, entry_id)?.and_then(|(item, subject)| {
            WebAddressMessage::of_item(&item, &subject, machine).map(|message| message.to_body())
        }),
    )
}

#[cfg(test)]
mod tests;
