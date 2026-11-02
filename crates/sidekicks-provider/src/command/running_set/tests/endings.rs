use std::sync::{Arc, Mutex};
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::{binding, command, end, session, start};
use crate::command::running_set::RunningCommandSets;
use crate::port::run_host::test_host::{EngineCall, RecordingRunEngine};
use crate::port::running_command_publisher::RunningCommandPublisher as _;
use crate::run::delivery::LateAppendableRow;

// Fails when a command's ending lands on the binding its session runs on when the command ends,
// another run's after a later run or a fork move, or as a row the session's cursor stamps or
// absorbs. Mutations: `end_row` appending on the lookup's binding (the ending lands on
// `binding-b`); the appender dispatching a `SessionRow` (kind `sessionRow`).
#[tokio::test]
async fn a_commands_ending_lands_after_its_run_on_the_binding_it_started_on() {
    let bound = Arc::new(Mutex::new(binding("binding-a")));
    let lookup = Arc::clone(&bound);
    let engine = Arc::new(RecordingRunEngine::default());
    let sets = RunningCommandSets::new(
        Arc::new(move |_session: &SessionId| Some(lock(&lookup).clone())),
        Arc::<RecordingRunEngine>::clone(&engine),
    );

    sets.command_started(start("long", "cargo test"));
    *lock(&bound) = binding("binding-b");
    sets.command_ended(session(), command("long"), end(Some(0), None));
    tokio::time::timeout(
        Duration::from_secs(5),
        engine.wait_until(|calls| {
            calls
                .iter()
                .any(|call| matches!(call, EngineCall::Deliver(_)))
                .then_some(())
        }),
    )
    .await
    .expect("the ending is appended");

    let deliveries = engine.deliveries();
    assert_eq!(deliveries.len(), 1);
    let delivery = &deliveries[0];
    assert_eq!(
        (delivery.kind, delivery.binding_id.clone()),
        ("afterRunRow", Some(binding("binding-a")))
    );
    assert!(matches!(
        &delivery.row,
        Some(LateAppendableRow::AgentCommandEnded(ending)) if ending.command_id == command("long")
    ));
}
