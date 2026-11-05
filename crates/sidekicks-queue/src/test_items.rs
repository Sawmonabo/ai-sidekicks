//! The queue items the crate's and other crates' tests queue: each form a waiting item takes, and
//! the write that queues an item for a run.

use rusqlite::params;
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{PlanMessage, PlanMessageKind, QueueItemId};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::{ClientUuid, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_session::queue_store::{
    NewQueueItem, QueueItemBody, QueueMessageBody, insert_queue_item_statement,
};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::TestLog;

/// A waiting item's form, with the words it carries.
#[derive(Clone, Copy, Debug)]
pub enum Form {
    /// A lead message carrying only words.
    Words(&'static str),
    /// A lead message carrying a file beside its words.
    WithFiles(&'static str),
    /// A helper's message carrying only words.
    Helper(&'static str),
    /// A review of the staged changes.
    Review,
    /// A plan's build message.
    PlanMessage,
}

impl Form {
    /// The body an item of this form carries.
    pub fn body(self) -> QueueItemBody {
        match self {
            Self::Words(text) | Self::Helper(text) => QueueItemBody::Message(words(text)),
            Self::WithFiles(text) => QueueItemBody::Message(QueueMessageBody {
                attachments: Some(AttachmentReferenceList(vec![
                    ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id"),
                ])),
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

/// A message carrying only `text`.
pub fn words(text: &str) -> QueueMessageBody {
    QueueMessageBody {
        content: FreeFormText::new(text.to_owned()).expect("a test message"),
        attachments: None,
        skills: None,
        answers_question_id: None,
        output_speed_for_turn: None,
        workspace_id: None,
    }
}

/// Queues an item carrying `body` for `run_id` of `session_id` through `writer`, after every one
/// before it, and answers its id.
pub async fn insert_item(
    writer: &DatabaseWriter,
    session_id: SessionId,
    run_id: RunId,
    body: QueueItemBody,
) -> QueueItemId {
    let item = NewQueueItem {
        id: QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id"),
        session_id,
        body,
        target_run_id: run_id,
        device_id: None,
        client_idempotency_key: Some(
            ClientUuid::new(mint_uuid_v7().to_string()).expect("a minted UUID is a client key"),
        ),
        replaces_queue_item_id: None,
        now: WireInstant::now(),
    };
    writer
        .write(vec![insert_queue_item_statement(&item)])
        .await
        .expect("the test queues its item");
    item.id
}

/// Queues an item of `form` for `run_id` of `session_id` as [`insert_item`] does, a helper's
/// moved into a helper's box, and answers its id. A helper's item keeps the place it took in the
/// lead's queue, which the lead's next item takes again, so a test queues it after the lead's.
pub async fn insert_form(
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
