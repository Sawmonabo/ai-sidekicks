//! The shell table's open, retry, deletion, close and reorder, each shell's terminal failing to
//! start so no shell runs: one shell per key, a deletion that leaves no shell behind, the refusals
//! of a request naming no shell, and the drop of a record after its runtime stopped.

use std::sync::Arc;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    TerminalCloseRequest, TerminalId, TerminalOpenRequest, TerminalReorderRequest,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::list::UniqueList;
use tokio::sync::watch;

use super::ShellTable;
use super::test_table::{SESSION, session, table_fixture};
use crate::ipc::registry::{HandlerError, TransportId};
use crate::pty::shell::output::stream::ShellOutputSource;

const OTHER_SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f";

fn open_request(key: u8) -> TerminalOpenRequest {
    TerminalOpenRequest {
        session_id: session(),
        client_idempotency_key: ClientUuid::new(format!(
            "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c00{key:02}"
        ))
        .expect("a client UUID"),
    }
}

/// The session's shells in tab order.
fn order(table: &ShellTable) -> Vec<TerminalId> {
    table
        .shared
        .lock_sessions()
        .get(&session())
        .map(|session| session.order.clone())
        .unwrap_or_default()
}

/// The refusal code of a request the table refused.
fn refusal_code(error: HandlerError) -> RefusalCode {
    match error {
        HandlerError::Refused(refusal) => refusal.code,
        other @ (HandlerError::Internal(_) | HandlerError::Canceled) => {
            panic!("a refusal, not {other:?}")
        }
    }
}

fn reorder_request(session_id: &str, terminal_ids: Vec<TerminalId>) -> TerminalReorderRequest {
    TerminalReorderRequest {
        session_id: SessionId::new(session_id).expect("a session id"),
        terminal_ids: UniqueList::new(terminal_ids).expect("the shells are named once each"),
    }
}

// Fails when a retry with the key of an open under way, or of one that finished, starts a second
// shell.
#[tokio::test(flavor = "multi_thread")]
async fn a_retry_with_the_same_key_at_once_or_later_answers_the_first_open_s_shell() {
    let (_gate, gate_reader) = watch::channel(true);
    let fixture = table_fixture(gate_reader).await;

    let (first, retry) = tokio::join!(
        fixture.table.open(open_request(1)),
        fixture.table.open(open_request(1)),
    );
    let later = fixture.table.open(open_request(1)).await;
    let other_key = fixture.table.open(open_request(2)).await;

    let first = first.expect("the first open answers").terminal_id;
    assert_eq!(retry.expect("the retry answers").terminal_id, first);
    assert_eq!(later.expect("the later retry answers").terminal_id, first);
    let other_key = other_key.expect("another key opens").terminal_id;
    assert_eq!(order(&fixture.table), vec![first, other_key]);
}

// Fails when an open under way as the session's deletion begins keeps its shell, or an open during
// the deletion starts one.
#[tokio::test(flavor = "multi_thread")]
async fn a_deletion_ends_the_shell_an_open_under_way_starts_and_refuses_opens_until_it_settles() {
    let (gate, gate_reader) = watch::channel(false);
    let fixture = table_fixture(gate_reader).await;
    let table = Arc::clone(&fixture.table);

    let opening = tokio::spawn({
        let table = Arc::clone(&table);
        async move { table.open(open_request(1)).await }
    });
    while table
        .shared
        .lock_sessions()
        .get(&session())
        .is_none_or(|session| session.opening.is_empty())
    {
        tokio::task::yield_now().await;
    }
    let closing = tokio::spawn({
        let table = Arc::clone(&table);
        async move { table.close_session_shells(&session()).await }
    });
    while table
        .shared
        .lock_sessions()
        .get(&session())
        .is_none_or(|session| session.close_holds == 0)
    {
        tokio::task::yield_now().await;
    }
    gate.send_replace(true);
    let opened = opening.await.expect("the open's task ends");
    let hold = closing
        .await
        .expect("the deletion's task ends")
        .expect("the deletion ends every shell");
    let during = table.open(open_request(2)).await;
    drop(hold);
    let after = table.open(open_request(3)).await;

    assert_eq!(
        refusal_code(opened.expect_err("the open under way is refused")),
        RefusalCode::SessionNotFound
    );
    assert_eq!(
        refusal_code(during.expect_err("an open during the deletion is refused")),
        RefusalCode::SessionNotFound
    );
    let after = after
        .expect("an open after the deletion settled answers")
        .terminal_id;
    assert_eq!(order(&table), vec![after]);
}

// Fails when a shell outlives its close or a second close of it finds it again.
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_shell_leaves_its_session_and_a_second_close_finds_none() {
    let (_gate, gate_reader) = watch::channel(true);
    let fixture = table_fixture(gate_reader).await;
    let terminal_id = fixture
        .table
        .open(open_request(1))
        .await
        .expect("the open answers")
        .terminal_id;
    let close = TerminalCloseRequest {
        session_id: session(),
        terminal_id,
        force: None,
    };
    let device = DeviceId::new("device".to_owned()).expect("a device id");

    fixture
        .table
        .close(&close, &device)
        .await
        .expect("the close answers");
    let second = fixture.table.close(&close, &device).await;

    assert_eq!(order(&fixture.table), Vec::<TerminalId>::new());
    assert_eq!(
        refusal_code(second.expect_err("the second close is refused")),
        RefusalCode::TerminalNotFound
    );
}

// Fails when a reorder drops a shell it did not name, applies a list naming a shell the session
// lacks, or tells an unknown session from a missing shell wrongly; a write's lookup refuses the
// same way.
#[tokio::test(flavor = "multi_thread")]
async fn a_reorder_puts_the_named_shells_first_and_refuses_a_missing_shell_or_session() {
    let (_gate, gate_reader) = watch::channel(true);
    let fixture = table_fixture(gate_reader).await;
    let mut shells = Vec::new();
    for key in 1..=3 {
        shells.push(
            fixture
                .table
                .open(open_request(key))
                .await
                .expect("the open answers")
                .terminal_id,
        );
    }
    let missing = TerminalId::new("terminal-missing".to_owned()).expect("a terminal id");

    fixture
        .table
        .reorder(&reorder_request(
            SESSION,
            vec![shells[2].clone(), shells[0].clone()],
        ))
        .await
        .expect("the reorder answers");
    let reordered = order(&fixture.table);
    let missing_shell = fixture
        .table
        .reorder(&reorder_request(
            SESSION,
            vec![shells[1].clone(), missing.clone()],
        ))
        .await;
    let missing_session = fixture
        .table
        .reorder(&reorder_request(OTHER_SESSION, vec![shells[0].clone()]))
        .await;
    let lookup = fixture.table.input_lookup();
    let other_session = SessionId::new(OTHER_SESSION).expect("a session id");
    let shell_refusal = match lookup(&session(), &missing) {
        Ok(_) => panic!("a missing shell's input is found"),
        Err(refusal) => refusal.await,
    };
    let session_refusal = match lookup(&other_session, &shells[0]) {
        Ok(_) => panic!("another session's shell's input is found"),
        Err(refusal) => refusal.await,
    };

    assert_eq!(
        reordered,
        vec![shells[2].clone(), shells[0].clone(), shells[1].clone()]
    );
    assert_eq!(order(&fixture.table), reordered);
    assert_eq!(
        refusal_code(missing_shell.expect_err("a missing shell is refused")),
        RefusalCode::TerminalNotFound
    );
    assert_eq!(
        refusal_code(missing_session.expect_err("an unknown session is refused")),
        RefusalCode::SessionNotFound
    );
    assert_eq!(refusal_code(shell_refusal), RefusalCode::TerminalNotFound);
    assert_eq!(refusal_code(session_refusal), RefusalCode::SessionNotFound);
}

// Fails when an open while the terminals drain keeps a shell that did not start instead of
// answering that no shell can start.
#[tokio::test(flavor = "multi_thread")]
async fn an_open_while_the_terminals_drain_is_refused_as_the_backend_unavailable() {
    let (_gate, gate_reader) = watch::channel(true);
    let fixture = table_fixture(gate_reader).await;
    fixture
        .terminals
        .drain(std::time::Duration::from_secs(1))
        .await;

    let refused = fixture.table.open(open_request(1)).await;

    assert_eq!(
        refusal_code(refused.expect_err("the open is refused")),
        RefusalCode::TerminalBackendUnavailable
    );
    assert_eq!(order(&fixture.table), Vec::<TerminalId>::new());
}

// Fails when a record's work started from a drop runs on whichever runtime is current, which
// panics once the daemon's runtime has stopped.
#[test]
fn a_record_s_pane_ends_after_its_runtime_stopped_without_a_panic() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the runtime builds");
    let subscription_id =
        SubscriptionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0101").expect("a subscription id");
    let (fixture, record, _gate) = runtime.block_on(async {
        let (gate, gate_reader) = watch::channel(true);
        let fixture = table_fixture(gate_reader).await;
        let terminal_id = fixture
            .table
            .open(open_request(1))
            .await
            .expect("the open answers")
            .terminal_id;
        let record = fixture
            .table
            .shared
            .find_shell(&session(), &terminal_id)
            .expect("the shell is held");
        record.add_stream(subscription_id, TransportId(1));
        (fixture, record, gate)
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(5));

    record.end_output_subscription(subscription_id, TransportId(1));
    drop(record);
    drop(fixture);
}
