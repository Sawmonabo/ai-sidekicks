//! What a service's process exit takes from one session, dropped on the session's task: its turns
//! with their routes, pauses and continues, and its helpers' child runs.

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::session::calls::{CodexSessionCallDependencies, CodexSessionTask};

/// What a process exit took from one session: the runs whose turns ended with it, its helpers'
/// child runs, and the binding its conversation ran under.
pub(crate) struct CodexDroppedTurns {
    /// The runs whose turns ended, each once, oldest turn first, none a helper's child run.
    pub(crate) run_ids: Vec<RunId>,
    /// The helpers' child runs, each once.
    pub(crate) helper_run_ids: Vec<RunId>,
    /// The binding, `None` before the session's first run.
    pub(crate) binding_id: Option<RuntimeBindingId>,
}

/// Drops every turn the session held on a service whose process ended, on the session's task: the
/// live, interrupted, paused and retried turns with their routes, pauses and continues, the
/// helpers' child runs, the marks of the turns held on the person, the compaction wait on the
/// conversation and the waits on its turns, which no turn ends now. Answers each run those turns
/// belonged to, then each helper's child run, once.
pub(crate) fn drop_codex_turns(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexSessionCallDependencies,
) -> CodexDroppedTurns {
    let record = &mut *task.record;
    // A helper's child run ends with the process even where no turn of its lead was live.
    let mut helper_run_ids: Vec<RunId> = Vec::new();
    let helpers = record
        .delivery
        .child_run_by_thread_id
        .drain()
        .filter_map(|(_, child)| child.bound.map(|bound| bound.child_run_id));
    for run_id in helpers {
        if !helper_run_ids.contains(&run_id) {
            helper_run_ids.push(run_id);
        }
    }
    let mut run_ids: Vec<RunId> = Vec::new();
    let held = record
        .active_turns
        .drain(..)
        .chain(record.interrupted_run_by_turn_id.drain(..))
        .chain(record.paused_run_id_by_interrupted_turn_id.drain())
        .chain(record.delivery.retried_run_id_by_turn_id.drain());
    for (_, run_id) in held {
        if !run_ids.contains(&run_id) && !helper_run_ids.contains(&run_id) {
            run_ids.push(run_id);
        }
    }
    record.continues_awaiting_pause.clear();
    record.held_continuation_turn_ids.clear();
    record.answer_steer_by_turn_id.clear();
    record.answer_turn_owed_run_ids.clear();
    record.pause_run_id_by_turn_id.clear();
    record.interrupting_turn_ids.clear();
    record.turn_input_by_turn_id.clear();
    record.delivery.unowned_turn_ids.clear();
    record.delivery.turn_opening_by_turn_id.clear();
    dependencies
        .runs
        .run_routes
        .forget_run_routes(record.session_id);
    dependencies
        .forks
        .pending_compactions
        .release_binding(&codex_compaction_wait_key(record, &record.thread_id));
    task.waiters
        .abandon(record.session_id, CodexRecordExit::SessionContinues);
    CodexDroppedTurns {
        run_ids,
        helper_run_ids,
        binding_id: record.binding_id.clone(),
    }
}
