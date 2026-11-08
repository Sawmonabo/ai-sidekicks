//! The forms of the waiting items the crate's tests queue, each queued through the session crate's
//! test writer.

use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{PlanMessage, PlanMessageKind, QueueItemId, QueuedSkillPick};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::queue_store::test_items::{insert_item, words};
use sidekicks_session::queue_store::{QueueItemBody, QueueMessageBody};
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::TestLog;

/// A waiting item's form, with the words it carries.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Form {
    /// A lead message carrying only words.
    Words(&'static str),
    /// A lead message carrying the artifact `file`, a skill pick, the turn speed `speed` and, where
    /// given, the repository `workspace` beside its words `text`.
    WithExtras {
        text: &'static str,
        file: &'static str,
        speed: &'static str,
        workspace: Option<&'static str>,
    },
    /// A helper's message carrying only words.
    Helper(&'static str),
    /// A review of the staged changes.
    Review,
    /// A plan's build message.
    PlanMessage,
}

impl Form {
    /// The body an item of this form carries.
    pub(crate) fn body(self) -> QueueItemBody {
        match self {
            Self::Words(text) | Self::Helper(text) => QueueItemBody::Message(words(text)),
            Self::WithExtras {
                text,
                file,
                speed,
                workspace,
            } => QueueItemBody::Message(QueueMessageBody {
                attachments: Some(AttachmentReferenceList(vec![
                    ArtifactId::new(file).expect("a fixed artifact id"),
                ])),
                skills: Some(vec![
                    serde_json::from_value(json!({ "name": "review", "path": "/skills/review" }))
                        .expect("a resolved pick"),
                ]),
                skill_picks: Some(vec![QueuedSkillPick {
                    name: FreeFormText::new("review".to_owned()).expect("a skill name"),
                    folder_path: FilesystemPath::new("/skills/review".to_owned())
                        .expect("a skill folder"),
                }]),
                output_speed_for_turn: Some(FreeFormText::new(speed.to_owned()).expect("a speed")),
                workspace_id: workspace
                    .map(|workspace| WorkspaceId::new(workspace).expect("a fixed repository id")),
                ..words(text)
            }),
            Self::Review => QueueItemBody::Review {
                target: SessionReviewTarget::Staged,
            },
            Self::PlanMessage => QueueItemBody::PlanMessage {
                plan_message: PlanMessage {
                    plan_id: PlanId::try_from(mint_uuid_v7()).expect("a minted UUID is a plan id"),
                    kind: PlanMessageKind::Build,
                    source_session_id: None,
                },
                text: FreeFormText::new("Implement the plan.".to_owned()).expect("a plan message"),
            },
        }
    }
}

/// Queues an item of `form` for `run_id` of `session_id` as [`insert_item`] does, a helper's
/// moved into a helper's box, and answers its id. A helper's item keeps the place it took in the
/// lead's queue, which the lead's next item takes again, so a test queues it after the lead's.
pub(crate) async fn insert_form(
    database: &TestDatabase,
    log: &TestLog,
    session_id: SessionId,
    run_id: RunId,
    form: Form,
) -> QueueItemId {
    let item_id = insert_item(&log.writer, session_id, run_id, form.body()).await;
    if let Form::Helper(_) = form {
        database
            .reader()
            .execute(
                "UPDATE queue_items SET child_handle = 'helper' WHERE id = ?1",
                params![item_id.text().as_str()],
            )
            .expect("the test moves the message into a helper's box");
    }
    item_id
}
