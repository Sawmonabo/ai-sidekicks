//! What a lead's landing does beside its settlement: the bindings its helpers ride moved with it,
//! and a move a driver reports with no switch waiting on it landed as a switch's lead is.

use futures::FutureExt as _;
use rusqlite::params;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::provider::account::record::{
    ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::account::{FirstRequestAfterMove, SessionAccountMove};
use sidekicks_provider::runtime_binding::store::{CreateRuntimeBindingInput, read_binding};
use sidekicks_provider::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build,
};
use sidekicks_session::agent_tree::store::{NewAgentTreeNode, insert_node};
use sidekicks_session::run::engine::test_fixture::insert_run;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::statement::run_statement;

use super::{Fixture, actor, first_provider, fixture};

impl Fixture {
    // A lead run of `session_id` in `state` with a binding on `runs_on`: the run and its binding.
    async fn bound_lead_run(
        &self,
        session_id: SessionId,
        state: &str,
        runs_on: &ProviderAccountId,
    ) -> (RunId, RuntimeBindingId) {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_run(&self.database, session_id, run_id, state);
        let binding = self
            .bindings
            .create(CreateRuntimeBindingInput {
                run_id,
                ..binding_input(
                    spawn_config_on(runs_on.clone()),
                    spawned_build("1.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the run's binding is recorded");
        (run_id, binding.id)
    }

    // The provider's helper `subagent_id`, running under `parent`, with its node in the tree.
    fn running_helper(&self, session_id: SessionId, parent: RunId, subagent_id: &str) {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let reader = self.database.reader();
        reader
            .execute(
                "INSERT INTO runs
                   (run_id, session_id, parent_run_id, reached_by, state, run_version)
                 VALUES (?1, ?2, ?3, 'providerSubagent', 'running', 1)",
                params![
                    run_id.text().as_str(),
                    session_id.text().as_str(),
                    parent.text().as_str(),
                ],
            )
            .expect("the test writes the helper's run");
        let node = NewAgentTreeNode {
            child_handle: ChildHandle::new(format!("handle-{subagent_id}"))
                .expect("a child handle"),
            session_id,
            provider_name: first_provider(),
            subagent_id: subagent_id.to_owned(),
            parent_subagent_id: None,
            parent_child_handle: None,
            name: None,
            role: None,
            provider_path: None,
            model_id: None,
            effort: None,
            start_call_id: None,
            own_run_id: run_id,
            started_at: WireInstant::now(),
        };
        run_statement(&reader, &insert_node(&node)).expect("the test writes the helper's node");
    }

    // The account binding `binding_id` runs on.
    fn account_of(&self, binding_id: &RuntimeBindingId) -> ProviderAccountId {
        read_binding(&self.database.reader(), binding_id)
            .expect("the binding reads")
            .expect("the binding has a row")
            .spawn_config
            .provider_account_id
    }
}

// A moved lead's helpers move with it in its landing: the binding of the lead run one helper runs
// under, and that of an earlier lead run a helper it left running still runs under, read the new
// account, while an ended lead run's binding no helper runs under stays. A helper left on the old
// account spends that account's limit. Killed by the bindings' move dropped from the landing (both
// read the old account), by a helper's own run read in place of the run it runs under (it has no
// binding, so neither moves), and by every binding of the session moved (the ended one moves).
#[tokio::test]
async fn a_moved_leads_helpers_move_with_it() {
    let fixture = fixture().await;
    let old = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let session_id = fixture
        .session(PROVIDERS[0].id, &old, None, PermissionLevel::Ask, false)
        .await;
    let (_, ended) = fixture.bound_lead_run(session_id, "completed", &old).await;
    let (earlier, left_running_on) = fixture.bound_lead_run(session_id, "completed", &old).await;
    let (current, current_binding) = fixture.bound_lead_run(session_id, "running", &old).await;
    fixture.running_helper(session_id, earlier, "helper-left-running");
    fixture.running_helper(session_id, current, "helper-current");

    let made = fixture
        .switch
        .make_current(to.clone(), actor())
        .await
        .expect("the switch is made");
    made.settled.await.expect("the moves settle");

    assert_eq!(made.moving_sessions, [session_id]);
    assert_eq!(fixture.account_of(&current_binding), to);
    assert_eq!(fixture.account_of(&left_running_on), to);
    assert_eq!(fixture.account_of(&ended), old);
}

// Fails when a session a driver moved with no switch waiting on the move does not land as a
// switch's lead lands: `changed` in place by the person whose switch moved it, else by this
// machine's own device, its level the new account cannot run moved to `ask` with one notice, and
// its first request's hand-back recorded; or when a session whose log names no lead records
// anything; or when a move reported once the switch is gone lands, as one through a switch the
// record held strongly would.
#[tokio::test]
async fn a_move_no_switch_waits_on_lands_as_a_switch_lead_does() {
    let fixture = fixture().await;
    let left = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let to = fixture
        .register(ProviderAccountHealthState::Authenticated)
        .await;
    let reviewed = fixture
        .session(
            PROVIDERS[0].id,
            &left,
            None,
            PermissionLevel::Reviewed,
            true,
        )
        .await;
    let by_machine = fixture
        .session(PROVIDERS[0].id, &left, None, PermissionLevel::Ask, true)
        .await;
    let no_lead = SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
    insert_session_row(
        &fixture.database.reader(),
        no_lead.text().as_str(),
        None,
        None,
    );
    let person = actor();
    let handed_back = SessionAccountMove {
        session_id: reviewed,
        first_request: futures::future::ready(Ok(FirstRequestAfterMove::HandedBack)).boxed(),
    };

    for (moved, moved_by) in [
        (handed_back, Some(person.clone())),
        (SessionAccountMove::unobserved(by_machine), None),
    ] {
        fixture
            .move_record
            .land(moved, to.clone(), moved_by)
            .await
            .expect("the lead reads")
            .await
            .expect("the landing ends");
    }
    let unled = fixture
        .move_record
        .land(SessionAccountMove::unobserved(no_lead), to.clone(), None)
        .await;

    let events = fixture.appended(reviewed);
    let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "agent.providerBinding.changed",
            "session.notice.posted",
            "agent.providerBinding.changeFailed"
        ]
    );
    assert_eq!(events[0].1["landedProviderAccountId"], to.as_str());
    assert_eq!(events[0].1["continuity"], "inPlace");
    assert_eq!(events[0].1["actor"], person.as_str());
    assert_eq!(events[1].1["kind"], "levelUnavailable");
    assert_eq!(events[2].1["accountState"], "reauthRequired");
    assert_eq!(events[2].1["actor"], person.as_str());
    assert_eq!(
        *lock(&fixture.level_moves.0),
        [(reviewed, PermissionLevel::Ask)]
    );
    let by_machine_events = fixture.appended(by_machine);
    assert_eq!(by_machine_events.len(), 1);
    assert_eq!(
        by_machine_events[0].1["actor"],
        fixture.machine_device_id.as_str()
    );
    assert!(unled.is_none(), "a session with no lead lands nothing");
    assert_eq!(fixture.appended(no_lead), []);
    drop(fixture.switch);
    let unswitched = fixture
        .move_record
        .land(SessionAccountMove::unobserved(by_machine), to, None)
        .await;
    assert!(
        unswitched.is_none(),
        "a move once the switch is gone lands nothing"
    );
}
