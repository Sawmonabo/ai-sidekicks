//! The ends a retried undo comes to: a fork its cut left unrecorded is closed before the retry
//! cuts the source again, and a resend recorded with its cut is sent once however often it is
//! retried. A cut the provider made before a restart and the daemon never recorded is read in each
//! driver's own tests, since it turns on the provider's record.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rstest::rstest;
use sidekicks_contracts::session::restore::SessionRestoreResend;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_provider::runtime_binding::store::mint_runtime_binding_id;
use sidekicks_session::checkpoints::restore_cuts::read_recorded_cut;
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_session::run::engine::undo::RollbackCompanions;
use sidekicks_session::run::state_change::RunWriteCompanions;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};

use super::super::client_key;
use super::{ProcessClose, applied_in_place, applied_on_fork, device, scene};
use crate::provider_session::errors::ProviderSessionError;
use crate::service::undo::{ConversationCut, ConversationCutError, ProviderCut};

/// How a retried undo's first attempt ended.
#[derive(Clone, Copy, Debug)]
enum FirstAttempt {
    /// The provider cut onto a fork whose rollback the store refused, and the fork's close failed.
    ForkLeftRunning,
    /// The cut applied with a resend, and the reply was lost before the resend was sent.
    ReplyLost,
}

/// Companions whose one statement matches no row, so the rollback's write that holds them fails.
fn refusing_companions() -> RollbackCompanions {
    let mut write = RunWriteCompanions::default();
    write.statements = vec![WriteStatement {
        sql: Cow::Borrowed("SELECT 1 WHERE 0"),
        bindings: StatementBindings::None,
        expected_row_count: Some(1),
    }];
    RollbackCompanions {
        write,
        ..RollbackCompanions::default()
    }
}

// A retried undo ends as the undo asked for. A fork the first attempt left running, its rollback
// refused and its close failed, takes nothing while a close of it fails, then is closed, and the
// retry cuts the source conversation in place. A resend recorded with an applied cut is sent under
// the undo's key by each of two retries and lands once. Killed by a fork never closed again, by a
// process opened while the fork runs, by the retry reading the source as cut, by the resend left
// out of the key's record, and by a resend sent under a key of its own.
#[rstest]
#[case::fork_left_running(FirstAttempt::ForkLeftRunning)]
#[case::reply_lost(FirstAttempt::ReplyLost)]
#[tokio::test]
async fn a_retried_undo_ends_applied(#[case] first_attempt: FirstAttempt) {
    let fork_binding_id = mint_runtime_binding_id();
    let fork_answer = applied_on_fork(&fork_binding_id, "fork-conversation");
    let in_place = applied_in_place();
    let asked = Arc::new(AtomicUsize::new(0));
    let is_forked_first = matches!(first_attempt, FirstAttempt::ForkLeftRunning);
    let counted = Arc::clone(&asked);
    let scene = scene(Arc::new(move || {
        if is_forked_first && counted.fetch_add(1, Ordering::SeqCst) == 0 {
            fork_answer()
        } else {
            in_place()
        }
    }))
    .await;
    let fixture = &scene.fixture;
    let provider_sessions = &fixture.queue.provider_sessions;
    let source_binding_id = provider_sessions
        .binding_cursors()
        .current_binding(&fixture.session_id)
        .expect("the scene runs on a binding");
    let undo_key = client_key();
    let hold = fixture
        .queue
        .hold_for_undo(fixture.session_id, undo_key.clone())
        .await;
    let reach = scene.reach().await;

    match first_attempt {
        FirstAttempt::ForkLeftRunning => {
            // The cut's close of the fork fails, and so does the one the next open makes.
            scene.failing_closes.store(2, Ordering::SeqCst);
            let first = fixture
                .queue
                .cut_conversation(
                    &hold,
                    &reach,
                    refusing_companions(),
                    ProviderCut::ToMake,
                    None,
                )
                .await;
            let opened_while_running = provider_sessions
                .open(fixture.session_id, scene.run_id)
                .await;
            provider_sessions
                .close_unclosed_fork(fixture.session_id)
                .await
                .expect("the fork closes at last");
            let retry_reach = scene.reach().await;
            let provider_cut = fixture
                .queue
                .read_provider_cut(fixture.session_id, &retry_reach)
                .await
                .expect("the provider's read answers");
            let retried = fixture
                .queue
                .cut_conversation(
                    &hold,
                    &retry_reach,
                    RollbackCompanions::default(),
                    provider_cut,
                    None,
                )
                .await;

            assert!(
                matches!(
                    first,
                    Err(ConversationCutError::ForkUnrecorded(
                        ProviderSessionError::UnclosedFork { .. }
                    ))
                ),
                "{first:?}"
            );
            assert!(
                matches!(
                    opened_while_running,
                    Err(ProviderSessionError::UnclosedFork { .. })
                ),
                "{opened_while_running:?}"
            );
            assert_eq!(provider_cut, ProviderCut::ToMake);
            assert!(
                matches!(retried, Ok(ConversationCut::Applied { .. })),
                "{retried:?}"
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 2);
            let closes = scene.closes.lock().expect("unpoisoned");
            assert_eq!(closes.len(), 3);
            assert!(closes.iter().all(|close| matches!(
                close,
                ProcessClose {
                    cause: SessionCloseCause::UnrecordedOpening,
                    is_append_lock_free: true,
                    is_queue_lock_free: true,
                }
            )));
            let binding_cursors = provider_sessions.binding_cursors();
            assert_eq!(
                binding_cursors.current_binding(&fixture.session_id),
                Some(source_binding_id)
            );
            assert!(!binding_cursors.is_binding_open(&fork_binding_id));
            let rolled_back = fixture
                .event_types()
                .into_iter()
                .filter(|event_type| event_type == "agent.run.rolledBack")
                .count();
            assert_eq!(rolled_back, 1);
        }
        FirstAttempt::ReplyLost => {
            let resend = SessionRestoreResend {
                content: FreeFormText::new("Look closer".to_owned()).expect("a test message"),
                attachments: None,
                skills: None,
                output_speed_for_turn: None,
            };
            fixture
                .queue
                .cut_conversation(
                    &hold,
                    &reach,
                    RollbackCompanions::default(),
                    ProviderCut::ToMake,
                    Some(&resend),
                )
                .await
                .expect("the cut applies");
            // The first attempt's resend is never sent: its reply was lost with the process.
            fixture
                .queue
                .release_undo_hold(hold, None, device())
                .await
                .expect("the first attempt lets the session go");
            let items_before = fixture.count_items();
            for _ in 0..2 {
                let retry = fixture
                    .queue
                    .hold_for_undo(fixture.session_id, undo_key.clone())
                    .await;
                let recorded =
                    read_recorded_cut(&fixture.database.reader(), fixture.session_id, &undo_key)
                        .expect("the key's record reads")
                        .expect("the key recorded its cut");
                fixture
                    .queue
                    .release_undo_hold(retry, recorded.resend, device())
                    .await
                    .expect("the retry sends the resend");
            }

            assert_eq!(fixture.count_items(), items_before + 1);
            let resent = QueueItemReader::new(&fixture.database.reader())
                .get_by_idempotency_key(&fixture.session_id, &undo_key)
                .expect("the resend reads")
                .expect("the resend went under the undo's key");
            assert_eq!(
                resent
                    .body
                    .as_message()
                    .map(|message| message.content.as_str()),
                Some("Look closer")
            );
            assert_eq!(scene.rewinds.load(Ordering::SeqCst), 1);
        }
    }
}
