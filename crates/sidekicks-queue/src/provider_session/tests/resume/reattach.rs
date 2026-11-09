//! The helpers a relaunch re-attaches: those live before the driver ran, a stop in progress aside,
//! handed to the driver once the relaunch is recorded; nothing on a process already up or with
//! nothing live, and a driver's failure leaves the resume standing.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::run_control::{ReattachHelpersParams, ReattachedHelper};
use sidekicks_provider::driver::test_registry::{first_provider, new_run_id};
use sidekicks_session::agent_tree::store::{NewAgentTreeNode, insert_node};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::statement::run_statement;
use tokio::time::timeout;

use super::super::{Opening, WAIT, unresolvable_provider};
use super::insert_run_event;

/// The provider's own id of the helper that was live before the restart.
const LIVE_HELPER: &str = "helper-live";

/// The provider's own id of the helper whose stop was in progress.
const STOPPING_HELPER: &str = "helper-stopping";

// Writes the provider's helper `subagent_id` of `lead` as `run_id` in `state`, its start at
// `sequence` of the session's log, and its node in the session's tree.
fn insert_helper(
    opening: &Opening,
    (run_id, lead): (RunId, RunId),
    subagent_id: &str,
    state: &str,
    sequence: i64,
) {
    let reader = opening.database.reader();
    reader
        .execute(
            "INSERT INTO runs (run_id, session_id, parent_run_id, reached_by, state, run_version)
             VALUES (?1, ?2, ?3, 'providerSubagent', ?4, 1)",
            params![
                run_id.text().as_str(),
                opening.session_id.text().as_str(),
                lead.text().as_str(),
                state,
            ],
        )
        .expect("the test writes the helper's run");
    insert_run_event(
        &opening.database,
        opening.session_id,
        sequence,
        (SessionEventType::AgentSubagentStarted, lead, None),
        &json!({
            "sessionId": opening.session_id.text().as_str(),
            "runId": lead.text().as_str(),
            "provider": first_provider().as_str(),
            "subagentId": subagent_id,
            "childRunId": run_id.text().as_str(),
        }),
    );
    let node = NewAgentTreeNode {
        child_handle: ChildHandle::new(format!("handle-{subagent_id}")).expect("a child handle"),
        session_id: opening.session_id,
        provider_name: first_provider(),
        subagent_id: subagent_id.to_owned(),
        parent_subagent_id: None,
        parent_child_handle: None,
        name: None,
        role: None,
        provider_path: None,
        ask: None,
        model_id: None,
        effort: None,
        start_call_id: None,
        own_run_id: run_id,
        started_at: WireInstant::now(),
    };
    run_statement(&reader, &insert_node(&node)).expect("the test writes the helper's node");
}

// Whether the binding `binding_id` has its row in the database at `path`.
fn has_binding_row(path: &Mutex<Option<PathBuf>>, binding_id: &RuntimeBindingId) -> bool {
    let path = lock(path).clone().expect("the test names its database");
    rusqlite::Connection::open(path)
        .expect("the test opens its database")
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM runtime_bindings WHERE id = ?1)",
            [binding_id.as_str()],
            |row| row.get(0),
        )
        .expect("the test reads the bindings")
}

// A resume after a restart hands the driver the helper live before it, once the binding it minted
// is recorded, and leaves out the helper whose stop was in progress. The fresh process holds no
// helper, so the live one is ended while the driver runs, as the settle of its answer ends it.
// Killed by the set read after the driver ran (the live helper dropped), by a stopping helper kept
// (it joins the list), and by the call made before the binding's record (no row as it runs).
#[tokio::test]
async fn a_recorded_relaunch_reattaches_the_helpers_live_before_it() {
    let database_path = Arc::new(Mutex::new(None::<PathBuf>));
    let reattached = Arc::new(Mutex::new(Vec::new()));
    let (live_helper, stopping_helper) = (new_run_id(), new_run_id());
    let opening = Opening::new(
        Box::new({
            let database_path = Arc::clone(&database_path);
            move |_params| {
                let path = lock(&database_path)
                    .clone()
                    .expect("the test names its database");
                rusqlite::Connection::open(path)
                    .expect("the test opens its database")
                    .execute(
                        "UPDATE runs SET state = 'interrupted' WHERE run_id = ?1",
                        [live_helper.text().as_str()],
                    )
                    .expect("the test ends the live helper");
            }
        }),
        Box::new(|| {}),
        |driver, watch| {
            let (handed_ids, reattached) = (Arc::clone(&watch.handed_ids), Arc::clone(&reattached));
            let database_path = Arc::clone(&database_path);
            driver
                .expect_reattach_helpers()
                .times(1)
                .returning(move |params| {
                    let handed_id = lock(&handed_ids)
                        .last()
                        .cloned()
                        .expect("the resume handed its process a binding");
                    let has_row = has_binding_row(&database_path, &handed_id);
                    lock(&reattached).push((params, has_row));
                    async { Ok(()) }.boxed()
                });
        },
    )
    .await;
    *lock(&database_path) = Some(opening.database.path());
    let lead = opening.earlier_run_id;
    insert_helper(&opening, (live_helper, lead), LIVE_HELPER, "running", 100);
    insert_helper(
        &opening,
        (stopping_helper, lead),
        STOPPING_HELPER,
        "running",
        101,
    );
    // A token limit no stop answered wins over the helper's resume.
    insert_run_event(
        &opening.database,
        opening.session_id,
        102,
        (
            SessionEventType::AgentRunTokenLimitReached,
            stopping_helper,
            None,
        ),
        &json!({}),
    );

    timeout(
        WAIT,
        opening.sessions.resume_after_restart(opening.session_id),
    )
    .await
    .expect("the resume takes its own lock once")
    .expect("the conversation resumes");

    assert_eq!(
        *lock(&reattached),
        [(
            ReattachHelpersParams {
                session_id: opening.session_id,
                helpers: vec![ReattachedHelper {
                    run_id: live_helper,
                    parent_run_id: lead,
                    subagent_id: SubagentId::new(LIVE_HELPER.to_owned()).expect("a helper id"),
                    parent_subagent_id: None,
                    start_call_id: None,
                    provider_path: None,
                    model_id: None,
                    was_live: true,
                }],
            },
            true,
        )],
        "the driver re-attaches the live helper alone, after the binding's record"
    );
}

/// How a relaunch with a helper in the tree goes.
#[derive(Clone, Copy, Debug)]
enum HelperRelaunch {
    /// A process already up answers on the binding that brought it up.
    AlreadyUp,
    /// The helper ended before the restart.
    NothingLive,
    /// The driver fails the re-attach.
    DriverFails,
}

// A relaunch re-attaches nothing on a process already up, which never went down, nor with no
// helper live; a driver failing the re-attach leaves the resume answered and the session opened.
// Killed by a re-attach on the already-up branch, a call with nothing live, and the driver's error
// propagated (the resume fails and the process closes).
#[rstest]
#[case::already_up(HelperRelaunch::AlreadyUp)]
#[case::nothing_live(HelperRelaunch::NothingLive)]
#[case::driver_fails(HelperRelaunch::DriverFails)]
#[tokio::test]
async fn a_relaunch_reattaches_only_a_live_helper_and_survives_a_failed_one(
    #[case] relaunch: HelperRelaunch,
) {
    let opening = Opening::new(Box::new(|_| {}), Box::new(|| {}), |driver, _| {
        let reattach = driver.expect_reattach_helpers();
        match relaunch {
            HelperRelaunch::DriverFails => {
                reattach
                    .times(1)
                    .returning(|_params| async { Err(unresolvable_provider(false)) }.boxed());
            }
            HelperRelaunch::AlreadyUp | HelperRelaunch::NothingLive => {
                reattach.never();
            }
        }
    })
    .await;
    if matches!(relaunch, HelperRelaunch::AlreadyUp) {
        *lock(&opening.came_up_on) = Some(opening.predecessor_id.clone());
    }
    let state = match relaunch {
        HelperRelaunch::NothingLive => "completed",
        HelperRelaunch::AlreadyUp | HelperRelaunch::DriverFails => "running",
    };
    insert_helper(
        &opening,
        (new_run_id(), opening.earlier_run_id),
        LIVE_HELPER,
        state,
        100,
    );

    let resumed = timeout(
        WAIT,
        opening.sessions.resume_after_restart(opening.session_id),
    )
    .await
    .expect("the resume takes its own lock once");

    assert!(resumed.is_ok(), "the resume answers: {resumed:?}");
    assert!(
        opening.sessions.is_opened(opening.session_id),
        "the session stays opened"
    );
    assert_eq!(
        opening.closes.load(Ordering::SeqCst),
        0,
        "no process is closed"
    );
}
