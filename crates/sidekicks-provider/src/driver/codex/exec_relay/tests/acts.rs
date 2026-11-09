//! The person's acts on a relayed command: input written under one write id, a terminate held
//! for the wrapper's end of its command, and a stop answered done only on Codex's word.

use std::sync::Arc;

use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;

use super::{
    CALL, EXECUTOR_PROCESS, THREAD, command_id, exited, initialized_executor, relay_for,
    relay_reporting_to, session_threads,
};
use crate::bounded_poll::poll_until;
use crate::command::channel::test_support::{
    end_party, new_party_keys, party_command, ready_parties, sent_requests, write_party_record,
};
use crate::command::channel::{DaemonRequest, PartyRecord};
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::codex::exec_relay::RelayedCommand;
use crate::driver::codex::exec_relay::command_acts::write_input;
use crate::driver::codex::exec_relay::executor::ProcessEnd;
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
use crate::driver::contract::error::DriverError;
use crate::driver::test_registry::{new_run_id, new_session_id, test_driver_services};
use crate::port::running_command_publisher::{
    CommandStart, CommandStopCause, RunningCommandParams, RunningCommandPublisher as _,
    StopCommandParams,
};

// A write whose answer is late goes out once more under the same write id, which the executor
// takes once.
#[tokio::test(start_paused = true)]
async fn resends_a_late_write_under_its_write_id() {
    let (executor, mut fake) = initialized_executor().await;
    let command = RelayedCommand {
        session_id: new_session_id(),
        thread_id: THREAD.to_owned(),
        executor_process_id: EXECUTOR_PROCESS.to_owned(),
        terminal_process_id: "7".to_owned(),
        accepts_input: true,
        service_start: 0,
    };
    let answering = async {
        let first = fake.next_sent().await;
        let second = fake.next_sent().await;
        fake.write(&json!({ "id": second["id"], "result": { "status": "accepted" } }))
            .await;
        (first, second)
    };

    let command_id = command_id();
    let (written, (first, second)) = tokio::join!(
        write_input(&executor, &command, "yes\n", &command_id),
        answering
    );

    assert!(written.is_ok(), "{written:?}");
    assert_eq!(first["method"], "process/write");
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["params"], second["params"]);
    assert_eq!(first["params"]["chunk"], "eWVzCg==");
}

// A terminate of a command a wrapper runs first has the wrapper asked, through the session's real
// channel, to end its command, and is held until the executor reports the command ended or the
// hold runs out. Killed by a terminate passed on at once.
#[tokio::test]
async fn a_terminate_asks_the_paired_wrapper_first_and_passes_on_at_the_commands_end() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let sets = unbound_running_command_sets();
    let relay = relay_reporting_to(
        folder.path(),
        Some(Arc::clone(&sets)),
        session_threads(session_id),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let channel = relay
        .session_channel(session_id, &executor)
        .await
        .expect("the session's channel opens")
        .expect("the running commands are registered");
    relay.record_command(
        CALL.to_owned(),
        RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        },
    );
    sets.command_started(CommandStart {
        session_id,
        command_id: command_id(),
        run_id: new_run_id(),
        tool_call_id: None,
        binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
        name: NonEmptyText::new("sleep 60".to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        line: None,
        process_id: Some(EXECUTOR_PROCESS.to_owned()),
        is_backgrounded: false,
        can_move_to_background: false,
        accepts_input: false,
    });
    // The wrapper: a process under the executor's, whose start names the executor's process.
    let keys = new_party_keys();
    let mut wrapper = party_command(&keys, None)
        .spawn()
        .expect("the wrapper starts");
    let mut lines = std::io::BufRead::lines(std::io::BufReader::new(
        wrapper.stdout.take().expect("its output"),
    ));
    let party = ready_parties(&mut lines, 1)[0];
    write_party_record(
        &channel.channel,
        &keys,
        party,
        1,
        &PartyRecord::Starting {
            command: "sleep 60".to_owned(),
            stdout_path: None,
            process: Some(EXECUTOR_PROCESS.to_owned()),
        },
    );
    poll_until(
        || sets.paired_wrapper(session_id, &command_id()) == Some(party),
        |is_paired| *is_paired,
    )
    .await;
    // The wrapper's start is acknowledged and answered `Go`, so the stop is the third request.
    let written_requests = || sent_requests(&channel.channel, &keys, party);
    poll_until(|| written_requests().len(), |written| *written == 2).await;
    // From here the clock moves only once nothing can run, so the hold cannot run out before the
    // poll below, and a terminate passed on at once reaches the executor before it.
    tokio::time::pause();

    let terminate = json!({

        "id": 4,
        "method": "process/terminate",
        "params": { "processId": EXECUTOR_PROCESS },
    });
    let terminating = tokio::spawn(
        Arc::clone(&relay).forward_terminate(Arc::clone(&executor), terminate.to_string()),
    );
    poll_until(
        || written_requests().last() == Some(&DaemonRequest::Stop {}),
        |is_stop_last| *is_stop_last,
    )
    .await;

    // Held once the wrapper is asked: nothing has reached the executor yet. `next_line` is
    // cancel-safe, so this one poll loses no line.
    let sent_early = fake.next_sent().now_or_never();
    assert!(sent_early.is_none(), "sent at once: {sent_early:?}");
    assert!(!terminating.is_finished());
    fake.write(&exited(EXECUTOR_PROCESS)).await;
    assert_eq!(fake.next_sent().await, terminate);
    terminating.await.expect("the terminate passed on");
    end_party(wrapper);
}

// A stop of Codex's own background terminal is answered done only when Codex says it terminated.
#[tokio::test]
async fn stops_only_on_codex_terminated() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let mut scripted = start_scripted_codex_service();
    let mut driver = CodexDriver::new(&test_driver_services());
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let relay = scripted
        .service
        .exec_relay_or_insert_with(|| relay_for(session_id, folder.path()));
    let (executor, _fake) = initialized_executor().await;
    relay.take_executor(executor);
    let params = || StopCommandParams {
        command: RunningCommandParams {
            session_id,
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
            command_id: command_id(),
        },
        cause: CommandStopCause::Person,
    };

    for (terminated, answers_done) in [(false, false), (true, true)] {
        relay.record_command(
            CALL.to_owned(),
            RelayedCommand {
                session_id,
                thread_id: THREAD.to_owned(),
                executor_process_id: EXECUTOR_PROCESS.to_owned(),
                terminal_process_id: "7".to_owned(),
                accepts_input: false,
                service_start: 0,
            },
        );
        let answering = async {
            let request = scripted
                .next_request("thread/backgroundTerminals/terminate")
                .await;
            assert_eq!(
                request["params"],
                json!({ "threadId": THREAD, "processId": "7" })
            );
            scripted
                .script
                .answer(&request, &json!({ "terminated": terminated }));
        };
        let (stopped, ()) = tokio::join!(driver.stop_command(params()), answering);
        match stopped {
            Ok(_parties) => assert!(answers_done),
            Err(DriverError::Refused(refusal)) => {
                assert!(!answers_done);
                assert_eq!(refusal.code, RefusalCode::AgentCommandNotStopped);
            }
            Err(other) => panic!("the stop failed otherwise: {other:?}"),
        }
    }
}

// A stop of a command its wrapper ended still sends Codex's terminate, so Codex records the
// terminal stopped, and Codex's answer for a terminal it already let go reads as the stop done,
// with the wrapper among the parties reached. Killed by skipping the terminate once the wrapper
// ended the command, and by reading that answer as the command still running.
#[tokio::test]
async fn a_stop_the_wrapper_ended_still_terminates_in_codex() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let sets = unbound_running_command_sets();
    let mut scripted = start_scripted_codex_service();
    let mut driver = CodexDriver::new(&test_driver_services());
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let relay = scripted.service.exec_relay_or_insert_with(|| {
        relay_reporting_to(
            folder.path(),
            Some(Arc::clone(&sets)),
            session_threads(session_id),
        )
    });
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let channel = relay
        .session_channel(session_id, &executor)
        .await
        .expect("the session's channel opens")
        .expect("the running commands are registered");
    relay.record_command(
        CALL.to_owned(),
        RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        },
    );
    let binding_id = RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id");
    sets.command_started(CommandStart {
        session_id,
        command_id: command_id(),
        run_id: new_run_id(),
        tool_call_id: None,
        binding_id: binding_id.clone(),
        name: NonEmptyText::new("sleep 60".to_owned()).expect("a name"),
        started_at: WireInstant::now(),
        line: None,
        process_id: Some(EXECUTOR_PROCESS.to_owned()),
        is_backgrounded: false,
        can_move_to_background: false,
        accepts_input: false,
    });
    let keys = new_party_keys();
    let mut wrapper = party_command(&keys, None)
        .spawn()
        .expect("the wrapper starts");
    let mut lines = std::io::BufRead::lines(std::io::BufReader::new(
        wrapper.stdout.take().expect("its output"),
    ));
    let party = ready_parties(&mut lines, 1)[0];
    write_party_record(
        &channel.channel,
        &keys,
        party,
        1,
        &PartyRecord::Starting {
            command: "sleep 60".to_owned(),
            stdout_path: None,
            process: Some(EXECUTOR_PROCESS.to_owned()),
        },
    );
    poll_until(
        || sets.paired_wrapper(session_id, &command_id()) == Some(party),
        |is_paired| *is_paired,
    )
    .await;
    let written_requests = || sent_requests(&channel.channel, &keys, party);
    poll_until(|| written_requests().len(), |written| *written == 2).await;
    let params = StopCommandParams {
        command: RunningCommandParams {
            session_id,
            binding_id,
            command_id: command_id(),
        },
        cause: CommandStopCause::Undo,
    };

    let answering = async {
        poll_until(
            || written_requests().last() == Some(&DaemonRequest::Stop {}),
            |is_stop_last| *is_stop_last,
        )
        .await;
        fake.write(&exited(EXECUTOR_PROCESS)).await;
        let request = scripted
            .next_request("thread/backgroundTerminals/terminate")
            .await;
        assert_eq!(
            request["params"],
            json!({ "threadId": THREAD, "processId": "7" })
        );
        scripted
            .script
            .answer(&request, &json!({ "terminated": false }));
    };
    let (stopped, ()) = tokio::join!(driver.stop_command(params), answering);

    let parties = stopped.expect("a terminal Codex already let go reads as stopped");
    assert_eq!(parties.process_ids(), [party]);
    end_party(wrapper);
}

// A stop of a relayed command whose process exited on its own while its item is still open is
// answered done, Codex's terminate still sent and its answer for the terminal it let go read as
// the stop done. Killed by taking such a command for Codex's background terminal.
#[tokio::test]
async fn a_stop_of_a_command_that_exited_before_its_item_ended_is_done() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let mut scripted = start_scripted_codex_service();
    let mut driver = CodexDriver::new(&test_driver_services());
    driver.registry = CodexServiceRegistry::holding(&scripted);
    let relay = scripted
        .service
        .exec_relay_or_insert_with(|| relay_for(session_id, folder.path()));
    relay.record_command(
        CALL.to_owned(),
        RelayedCommand {
            session_id,
            thread_id: THREAD.to_owned(),
            executor_process_id: EXECUTOR_PROCESS.to_owned(),
            terminal_process_id: "7".to_owned(),
            accepts_input: false,
            service_start: 0,
        },
    );
    relay.command_exited(CALL, Some(ProcessEnd { exit_code: Some(0) }));
    let params = StopCommandParams {
        command: RunningCommandParams {
            session_id,
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
            command_id: command_id(),
        },
        cause: CommandStopCause::Undo,
    };

    let answering = async {
        let request = scripted
            .next_request("thread/backgroundTerminals/terminate")
            .await;
        assert_eq!(
            request["params"],
            json!({ "threadId": THREAD, "processId": "7" })
        );
        scripted
            .script
            .answer(&request, &json!({ "terminated": false }));
    };
    let (stopped, ()) = tokio::join!(driver.stop_command(params), answering);

    stopped.expect("a command whose process exited reads as stopped");
}
