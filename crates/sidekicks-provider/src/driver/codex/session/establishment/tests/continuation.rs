//! Lead runs whose turn their service's end cut, continued as the conversation is adopted by its
//! handle: in a turn the daemon starts on its own service, in the turn Codex continued itself on a
//! service the daemon only joined, and in the turn a start left unanswered may have started; and
//! the leads left as they stand, held on the person or pausing, with what each answers and binds.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::service::supervisor::test_service::{
    start_scripted_codex_service, start_scripted_joined_service,
};
use crate::driver::codex::session::establishment::CodexEstablishedSession;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer,
};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::run_host::test_host::EngineCall;
use crate::run::posture::compose_execution_posture;
use crate::run::turn_end::TurnOutcome;
use crate::runtime_binding::resume::compose_resume_session_params;
use crate::runtime_binding::store::mint_runtime_binding_id;
use crate::runtime_binding::test_store::{
    binding_input, spawn_config_on, spawned_build, test_provider_account_id,
};

/// The conversation a resume by handle adopts, beside the test session's own.
pub(super) const ADOPTED_THREAD: &str = "thread-adopted";

/// The lead run's turn the end of its service cut.
pub(super) const CUT_TURN: &str = "turn-cut";

/// The first turn of the cut turn's chain.
pub(super) const ROOT_TURN: &str = "turn-root";

/// The turn Codex starts for the continuation.
pub(super) const CONTINUATION_TURN: &str = "turn-continued";

/// The first turn of a chain other than the cut turn's.
const OTHER_ROOT_TURN: &str = "turn-other-root";

/// The cut turn's number within its run.
const CUT_TURN_NUMBER: u64 = 2;

// A lead run standing at `run_state` with the cut turn open.
pub(super) fn lead_run(run_id: RunId, run_state: RunState) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: None,
        open_turns: vec![OpenTurnResume {
            turn_number: SafeInt::<1>::new(CUT_TURN_NUMBER).expect("two is a turn number"),
            provider_turn_id: Some(ProviderTurnId::new(CUT_TURN.to_owned()).expect("a turn id")),
            started_event_id: FreeFormText::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is an event id"),
        }],
        subagent_id: None,
        is_stopping: false,
        run_state,
    }
}

// What a resume by handle did: its result, the session it established, and each `thread/resume`,
// `turn/start` and `turn/interrupt` it sent.
pub(super) struct Adoption {
    pub(super) result: DriverResumeResult,
    pub(super) established: Option<CodexEstablishedSession>,
    pub(super) resumes: Vec<Value>,
    pub(super) turn_starts: Vec<Value>,
    pub(super) interrupts: Vec<Value>,
}

impl Adoption {
    // The answer for `run_id` the result gives.
    pub(super) fn answer_of(&self, run_id: RunId) -> ProviderTurnAnswer {
        let DriverResumeResult::Resumed { runs, .. } = &self.result else {
            panic!("the conversation is adopted: {:?}", self.result);
        };
        runs.iter()
            .find(|answer| answer.run_id == run_id)
            .map(|answer| answer.turn)
            .expect("the run is answered")
    }

    // The conversation's turn count the result gives.
    fn session_position(&self) -> u64 {
        let DriverResumeResult::Resumed {
            session_position, ..
        } = &self.result
        else {
            panic!("the conversation is adopted: {:?}", self.result);
        };
        session_position.get()
    }
}

// How the service answers an adoption: whether it holds the conversation loaded, the status each
// resume reads it at, the turns of each resume's page in order (none past the list, or where an
// entry is `None`), the turns it lists, each `turn/start`'s answer (a refusal where it holds an
// error), left unanswered where it is `None`, and how it answers for each helper.
pub(super) struct AdoptionScript {
    pub(super) is_loaded: bool,
    pub(super) status: &'static str,
    pub(super) resume_pages: Vec<Option<Value>>,
    pub(super) listed_turns: Value,
    pub(super) turn_start_answer: Option<Value>,
    pub(super) helpers: Vec<HelperScript>,
}

// How the service answers for one helper's conversation: whether it holds it loaded, its resume's
// page (a refusal where it holds an error), and the turns it lists, newest first. A helper no
// script names lists no turn.
pub(super) struct HelperScript {
    pub(super) thread_id: &'static str,
    pub(super) is_loaded: bool,
    pub(super) resume_page: Value,
    pub(super) listed_turns: Value,
}

impl AdoptionScript {
    // The conversation held unloaded and read idle with no page, its turns `listed_turns`, each
    // `turn/start` answered with `turn_start_answer`.
    fn unloaded(listed_turns: Value, turn_start_answer: Value) -> Self {
        Self {
            is_loaded: false,
            status: "idle",
            resume_pages: Vec::new(),
            listed_turns,
            turn_start_answer: Some(turn_start_answer),
            helpers: Vec::new(),
        }
    }

    // The conversation held loaded and read active, its resume's page holding `newest_turn`, its
    // turns `listed_turns`, and no `turn/start` answered.
    pub(super) fn loaded_active(listed_turns: Value, newest_turn: Value) -> Self {
        Self {
            is_loaded: true,
            status: "active",
            resume_pages: vec![Some(Value::Array(vec![newest_turn]))],
            listed_turns,
            turn_start_answer: None,
            helpers: Vec::new(),
        }
    }
}

// Adopts `ADOPTED_THREAD` by its handle on the test session's service, naming `live_runs`, the
// service answering as `answers` says.
pub(super) async fn adopt(
    session: &mut TestCodexSession,
    live_runs: Vec<LiveRunResume>,
    answers: AdoptionScript,
) -> Adoption {
    let folder = tempfile::tempdir().expect("the test makes a folder");
    let establishment = session.establishment(folder.path());
    session.scripted.report_version("codex-cli 0.163.0");
    let mut input = binding_input(
        spawn_config_on(test_provider_account_id()),
        spawned_build("0.163.0", "/opt/codex/bin"),
    );
    input.resume_handle = Some(ADOPTED_THREAD.to_owned());
    let binding = session
        .bindings
        .create(input)
        .await
        .expect("the binding is recorded");
    let params = compose_resume_session_params(
        new_session_id(),
        AgentId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an agent id"),
        &binding,
        mint_runtime_binding_id(),
        ProviderToken::new("gpt-5".to_owned()).expect("the model fits"),
        None,
        SessionMode::Build,
        compose_execution_posture(
            PermissionLevel::Readonly,
            FilesystemPath::new("/".to_owned()).expect("the root is a path"),
        ),
        Vec::new(),
        ProviderRowValues::default(),
        Vec::new(),
        live_runs,
    )
    .expect("the binding resumes");
    let AdoptionScript {
        is_loaded,
        status,
        resume_pages,
        listed_turns,
        turn_start_answer,
        helpers,
    } = answers;
    let loaded: Vec<&str> = is_loaded
        .then_some(ADOPTED_THREAD)
        .into_iter()
        .chain(
            helpers
                .iter()
                .filter(|helper| helper.is_loaded)
                .map(|helper| helper.thread_id),
        )
        .collect();
    let helper_of = |sent: &Value| {
        helpers
            .iter()
            .find(|helper| sent["params"]["threadId"] == helper.thread_id)
    };
    let script = &mut session.scripted.script;
    let mut resumes = Vec::new();
    let mut turn_starts = Vec::new();
    let mut interrupts = Vec::new();
    let resuming = establishment.resume_by_handle(&params);
    tokio::pin!(resuming);
    let resumed = loop {
        tokio::select! {
            resumed = &mut resuming => break resumed,
            sent = script.next_sent() => match (sent["method"].as_str(), helper_of(&sent)) {
                (Some("thread/loaded/list"), _) => {
                    script.answer(&sent, &json!({"data": loaded, "nextCursor": null}));
                }
                (Some("thread/resume"), Some(helper)) => {
                    resumes.push(sent.clone());
                    answer_helper_resume(script, &sent, helper);
                }
                (Some("thread/resume"), None) => {
                    let mut reply = json!({
                        "thread": {
                            "id": sent["params"]["threadId"],
                            "sessionId": "codex-session",
                            "status": {"type": status},
                        },
                        "activePermissionProfile": {"id": sent["params"]["permissions"]},
                    });
                    let lead_resumes = resumes
                        .iter()
                        .filter(|resume| resume["params"]["threadId"] == ADOPTED_THREAD)
                        .count();
                    if let Some(Some(page)) = resume_pages.get(lead_resumes) {
                        reply["initialTurnsPage"] = json!({"data": page, "nextCursor": null});
                    }
                    resumes.push(sent.clone());
                    script.answer(&sent, &reply);
                }
                (Some("thread/turns/list"), helper) => {
                    let turns = match helper {
                        Some(helper) => helper.listed_turns.clone(),
                        None if sent["params"]["threadId"] == ADOPTED_THREAD => {
                            listed_turns.clone()
                        }
                        None => json!([]),
                    };
                    script.answer(&sent, &json!({"data": turns, "nextCursor": null}));
                }
                (Some("thread/settings/update"), _) => script.answer(&sent, &json!({})),
                (Some("turn/interrupt"), _) => {
                    interrupts.push(sent.clone());
                    script.answer(&sent, &json!({}));
                }
                (Some("turn/start"), _) => {
                    turn_starts.push(sent.clone());
                    match &turn_start_answer {
                        Some(refusal) if refusal.get("error").is_some() => {
                            send_refusal(script, &sent, refusal);
                        }
                        Some(answer) => script.answer(&sent, answer),
                        // Left unanswered, so the start's deadline passes.
                        None => {}
                    }
                }
                (method, _) => panic!("the service was not asked {method:?}"),
            },
        }
    };
    Adoption {
        result: resumed.result,
        established: resumed.established,
        resumes,
        turn_starts,
        interrupts,
    }
}

// Answers `helper`'s resume `sent` with its page, or with its refusal.
fn answer_helper_resume(script: &ScriptedService, sent: &Value, helper: &HelperScript) {
    if helper.resume_page.get("error").is_some() {
        send_refusal(script, sent, &helper.resume_page);
        return;
    }
    script.answer(
        sent,
        &json!({
            "thread": {
                "id": helper.thread_id,
                "sessionId": "codex-session",
                "status": {"type": "active"},
            },
            "initialTurnsPage": {"data": helper.resume_page, "nextCursor": null},
        }),
    );
}

// Answers the request `sent` with `refusal`, an object holding its `error`.
fn send_refusal(script: &ScriptedService, sent: &Value, refusal: &Value) {
    let mut refusal = refusal.clone();
    refusal["jsonrpc"] = json!("2.0");
    refusal["id"] = sent["id"].clone();
    script.send(&refusal);
}

// The turn ends among `calls`: the daemon's own, then those its provider reported.
pub(super) fn turn_ends(calls: &[EngineCall]) -> (Vec<EngineCall>, Vec<EngineCall>) {
    let daemon_ends = calls
        .iter()
        .filter(|call| matches!(call, EngineCall::RecordDaemonTurnEnd(..)))
        .cloned()
        .collect();
    let provider_ends = calls
        .iter()
        .filter(|call| matches!(call, EngineCall::RecordTurnEnd(..)))
        .cloned()
        .collect();
    (daemon_ends, provider_ends)
}

// The cut turn as Codex lists it after a cold load: interrupted, with no end time, in the chain
// `ROOT_TURN` begins.
pub(super) fn cut_turn_listed() -> Value {
    json!({"id": CUT_TURN, "items": [], "status": "interrupted", "rootTurnId": ROOT_TURN})
}

// The turn `turn_id` standing at `status`, in the chain `root_turn_id` begins, as a page holds it.
pub(super) fn page_turn(turn_id: &str, status: &str, root_turn_id: &str) -> Value {
    let mut turn =
        json!({"id": turn_id, "items": [], "status": status, "rootTurnId": root_turn_id});
    if status != "inProgress" {
        turn["completedAt"] = json!(1_767_000_000);
    }
    turn
}

// The cut turn's end the daemon writes for `run_id`.
pub(super) fn cut_turn_end(run_id: RunId) -> EngineCall {
    EngineCall::RecordDaemonTurnEnd(
        run_id,
        SafeInt::<1>::new(CUT_TURN_NUMBER).expect("two is a turn number"),
        TurnOutcome::Interrupted(Some(TurnEndCause::DaemonRestart)),
    )
}

// A running lead whose turn the end of the daemon's own service cut, listed interrupted with no end
// time or not listed at all, continues in one turn carrying Codex's own continuation words: the
// cut turn ends in the log as the daemon's restart interrupted it, the new turn is the run's and
// the cut one is not, and the run answers still running. Killed by `Gone` kept (no turn sent), by
// the cut turn left bound (its listed end would end the run), by the cut turn left open in the log
// (a later restart binds it), by its end written as Codex's (the run ends), by a message id sent,
// and by the cut turn's own id sent as the root.
#[rstest]
#[case::listed_interrupted(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "rootTurnId": ROOT_TURN}]),
    Some(ROOT_TURN)
)]
#[case::not_listed(json!([]), None)]
#[tokio::test(start_paused = true)]
async fn a_lead_run_its_services_end_cut_continues_in_one_turn_of_codexs_words(
    #[case] listed_turns: Value,
    #[case] root_turn_id: Option<&str>,
) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::unloaded(
            listed_turns,
            json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
        ),
    )
    .await;

    let [turn_start] = adoption.turn_starts.as_slice() else {
        panic!("one turn is sent: {:?}", adoption.turn_starts);
    };
    let params = &turn_start["params"];
    assert_eq!(params["threadId"], ADOPTED_THREAD);
    assert_eq!(
        params["input"][0]["text"],
        "The server restarted and interrupted the previous turn. Continue the unfinished work \
         from the saved conversation. Check the current state before repeating actions that may \
         already have completed."
    );
    assert_eq!(params["turnTrigger"], "daemon_recovery");
    assert_eq!(
        params.get("rootTurnId").and_then(Value::as_str),
        root_turn_id
    );
    assert!(params["collaborationMode"].is_object());
    assert!(params["environments"].is_array());
    assert_eq!(params.get("clientUserMessageId"), None);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
    assert_eq!(established.record.active_turn_run(CUT_TURN), None);
    assert!(session.task.run_routes.binding_for(run_id).is_some());
}

// No turn continues a run the rows leave as it stands: a cut turn listed over, one stopped with its
// end time, a lead pausing, a lead waiting on the person, a lead held for a helper at any depth
// beneath it, a paused lead with no open turn, and the same listing on a service the daemon only
// joined, where Codex continues its own. No end is written; a lead held on the person answers
// `Waiting` and a cut pausing lead `Gone`, both with the cut turn unbound, as is every held helper
// `Waiting`; the rest answer as Codex's listing has it. Every lead keeps its deliveries' binding.
// Killed by the held arm dropped (`Waiting` reads `EndedByProvider`), by the pausing arm dropped
// (`Gone` reads `EndedByProvider`), by the cut turn bound for a held or pausing lead, by the
// binding kept only with a bound turn (the turnless cases), by the direct-child helper read kept
// (the grandchild case sends a `turn/start`), and by a held helper answered `Gone`.
#[rstest]
#[case::listed_completed(
    json!([{"id": CUT_TURN, "items": [], "status": "completed", "completedAt": 1_767_000_000}]),
    RunState::Running,
    true,
    vec![],
    false,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[case::interrupted_with_its_end_time(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "completedAt": 1_767_000_000}]),
    RunState::Running,
    true,
    vec![],
    false,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[case::pausing(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Pausing,
    true,
    vec![],
    false,
    ProviderTurnAnswer::Gone,
    false
)]
#[case::waiting_for_approval(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::WaitingForApproval,
    true,
    vec![],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::helper_paused(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![RunState::Paused],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::helper_waiting_beneath_a_running_helper(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![RunState::Running, RunState::WaitingForInput],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::paused_with_no_open_turn(
    json!([]),
    RunState::Paused,
    false,
    vec![],
    false,
    ProviderTurnAnswer::Gone,
    false
)]
#[case::joined_service(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![],
    true,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[tokio::test(start_paused = true)]
async fn no_turn_continues_a_run_the_rows_leave_as_it_stands(
    #[case] listed_turns: Value,
    #[case] lead_state: RunState,
    #[case] is_turn_open: bool,
    #[case] helper_states: Vec<RunState>,
    #[case] is_joined: bool,
    #[case] lead_answer: ProviderTurnAnswer,
    #[case] is_cut_turn_bound: bool,
) {
    let scripted = if is_joined {
        start_scripted_joined_service()
    } else {
        start_scripted_codex_service()
    };
    let mut session = TestCodexSession::start_on(scripted).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, lead_state);
    if !is_turn_open {
        lead.open_turns.clear();
    }
    let mut live_runs = vec![lead];
    // Each helper beneath the one before, the first beneath the lead.
    let mut helper_run_ids = Vec::new();
    for (depth, helper_state) in helper_states.into_iter().enumerate() {
        let helper_run_id = new_run_id();
        live_runs.push(LiveRunResume {
            run_id: helper_run_id,
            parent_run_id: Some(helper_run_ids.last().copied().unwrap_or(run_id)),
            open_turns: Vec::new(),
            subagent_id: Some(
                SubagentId::new(format!("thread-helper-{depth}")).expect("a helper id"),
            ),
            is_stopping: false,
            run_state: helper_state,
        });
        helper_run_ids.push(helper_run_id);
    }

    let adoption = adopt(
        &mut session,
        live_runs,
        AdoptionScript::unloaded(
            listed_turns,
            json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
        ),
    )
    .await;

    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    assert_eq!(adoption.answer_of(run_id), lead_answer);
    for helper_run_id in &helper_run_ids {
        assert_eq!(
            adoption.answer_of(*helper_run_id),
            ProviderTurnAnswer::Waiting
        );
    }
    assert_eq!(turn_ends(&session.engine.calls()), (Vec::new(), Vec::new()));
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CUT_TURN),
        is_cut_turn_bound.then_some(run_id)
    );
    assert!(session.task.run_routes.binding_for(run_id).is_some());
}

// A pausing lead whose turn still runs on the daemon's own service has that turn bound and marked
// to pause at its next step end, since a restart loses the mark its pause set; a running lead's
// turn is bound unmarked. Killed by the mark not set, and by every bound turn marked.
#[rstest]
#[case::pausing(RunState::Pausing)]
#[case::running(RunState::Running)]
#[tokio::test(start_paused = true)]
async fn a_pausing_leads_running_turn_is_marked_to_pause_at_its_next_step_end(
    #[case] run_state: RunState,
) {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, run_state)],
        AdoptionScript::loaded_active(
            json!([page_turn(CUT_TURN, "inProgress", ROOT_TURN)]),
            page_turn(CUT_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;

    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    let established = adoption.established.expect("the session is established");
    let record = &established.record;
    assert_eq!(record.active_turn_run(CUT_TURN), Some(run_id));
    assert_eq!(
        record.pause_run_id_by_turn_id.get(CUT_TURN),
        (run_state == RunState::Pausing).then_some(&run_id)
    );
}

// A continuation Codex refuses answers the run gone, its cut turn already ended in the log, and
// holds no turn for the run. Killed by `StillRunning` kept on a refusal.
#[tokio::test(start_paused = true)]
async fn a_refused_continuation_answers_the_run_gone() {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::unloaded(
            json!([cut_turn_listed()]),
            json!({"error": {"code": -32600, "message": "the turn is refused"}}),
        ),
    )
    .await;

    assert_eq!(adoption.turn_starts.len(), 1);
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Gone);
    assert_eq!(
        turn_ends(&session.engine.calls()),
        (vec![cut_turn_end(run_id)], Vec::new())
    );
    let established = adoption.established.expect("the session is established");
    assert_eq!(established.record.newest_active_turn_for_run(run_id), None);
    assert!(session.task.run_routes.binding_for(run_id).is_none());
}

// On a service the daemon only joined, Codex continued the cut turn itself before the daemon came
// back, and sends it no start of that turn: the resume asks for the newest turn, which shows the
// continuation running in the cut turn's chain, so the cut turn ends in the log, the continuation
// is held as the run's turn and opened after that end, no turn is sent, and the run answers still
// running, whether it runs, pauses, waits on the person, or stops; a pausing lead's continuation is
// marked to pause at its next step end. Killed by the page not asked (no continuation found; the
// run answers ended), by the continuation not opened (no turn opens), by the cut turn left bound,
// by the cut turn not ended, by the continuation opened before the cut turn's end, by a pausing
// lead left out (no continuation opens), and by the pausing lead's continuation left unmarked.
#[rstest]
#[case::running(RunState::Running, false)]
#[case::pausing(RunState::Pausing, false)]
#[case::waiting_for_approval(RunState::WaitingForApproval, false)]
#[case::stopping(RunState::Running, true)]
#[tokio::test(start_paused = true)]
async fn a_joined_services_running_continuation_is_held_and_opened_as_the_runs_turn(
    #[case] run_state: RunState,
    #[case] is_stopping: bool,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, run_state);
    lead.is_stopping = is_stopping;

    let adoption = adopt(
        &mut session,
        vec![lead],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN),
        ),
    )
    .await;

    let [resume] = adoption.resumes.as_slice() else {
        panic!("one resume is sent: {:?}", adoption.resumes);
    };
    assert_eq!(resume["params"]["excludeTurns"], true);
    assert_eq!(
        resume["params"]["initialTurnsPage"],
        json!({"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"})
    );
    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    let calls = session.engine.calls();
    let ended_at = calls
        .iter()
        .position(|call| *call == cut_turn_end(run_id))
        .expect("the cut turn is ended in the log");
    let opened_at = calls
        .iter()
        .position(|call| *call == EngineCall::StartTurn(run_id))
        .expect("the continuation is opened");
    assert!(
        ended_at < opened_at,
        "the continuation opened first: {calls:?}"
    );
    assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
    assert_eq!(adoption.session_position(), 2);
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CONTINUATION_TURN),
        Some(run_id)
    );
    assert_eq!(established.record.active_turn_run(CUT_TURN), None);
    assert_eq!(
        established
            .record
            .pause_run_id_by_turn_id
            .get(CONTINUATION_TURN),
        (run_state == RunState::Pausing).then_some(&run_id)
    );
}

// A continuation Codex already ended on a joined service is held for a running lead with no stop
// pending, unopened, so its listed end, routed as the session opens, opens it and ends the run:
// the cut turn ends in the log and the run answers ended. A stopping lead's is left to its stop:
// nothing is ended or held, and the cut turn stays bound as before. A pausing lead's is not taken
// either: the lead answers gone, so the daemon ends its cut turn as the pause owes, with that turn
// unbound and the lead's deliveries' binding kept for the person's continue. Every lead keeps
// that binding. Killed by the continuation not held (the run never ends), by the cut turn left
// bound (its listed end is routed), and by a pausing lead's ended continuation taken (the lead
// answers ended, its continuation held).
#[rstest]
#[case::running(RunState::Running, false, ProviderTurnAnswer::EndedByProvider)]
#[case::stopping(RunState::Running, true, ProviderTurnAnswer::EndedByProvider)]
#[case::pausing(RunState::Pausing, false, ProviderTurnAnswer::Gone)]
#[tokio::test(start_paused = true)]
async fn a_joined_services_ended_continuation_is_held_unless_a_stop_settles_its_run(
    #[case] run_state: RunState,
    #[case] is_stopping: bool,
    #[case] lead_answer: ProviderTurnAnswer,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, run_state);
    lead.is_stopping = is_stopping;

    let adoption = adopt(
        &mut session,
        vec![lead],
        AdoptionScript::loaded_active(
            json!([cut_turn_listed()]),
            page_turn(CONTINUATION_TURN, "completed", ROOT_TURN),
        ),
    )
    .await;

    assert_eq!(adoption.answer_of(run_id), lead_answer);
    let calls = session.engine.calls();
    assert!(!calls.contains(&EngineCall::StartTurn(run_id)));
    assert!(session.task.run_routes.binding_for(run_id).is_some());
    let established = adoption.established.expect("the session is established");
    let record = &established.record;
    if is_stopping || run_state == RunState::Pausing {
        assert_eq!(turn_ends(&calls), (Vec::new(), Vec::new()));
        assert_eq!(record.active_turn_run(CONTINUATION_TURN), None);
        assert_eq!(
            record.active_turn_run(CUT_TURN),
            is_stopping.then_some(run_id)
        );
    } else {
        assert_eq!(turn_ends(&calls), (vec![cut_turn_end(run_id)], Vec::new()));
        assert_eq!(record.active_turn_run(CONTINUATION_TURN), Some(run_id));
        assert_eq!(record.active_turn_run(CUT_TURN), None);
        assert!(
            established
                .listed_turns
                .iter()
                .any(|listed| listed.id == CONTINUATION_TURN)
        );
    }
}

// No continuation is read where the joined service's newest turn is the cut turn itself, or a turn
// of another chain: the run answers as Codex's listing has it, its cut turn bound, with no end
// written. Killed by a continuation told apart without its root, and by the cut turn ended with
// no continuation.
#[rstest]
#[case::the_cut_turn(cut_turn_listed())]
#[case::another_chain(page_turn(CONTINUATION_TURN, "inProgress", OTHER_ROOT_TURN))]
#[tokio::test(start_paused = true)]
async fn a_joined_services_newest_turn_outside_the_cut_chain_continues_nothing(
    #[case] newest_turn: Value,
) {
    let mut session = TestCodexSession::start_on(start_scripted_joined_service()).await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript::loaded_active(json!([cut_turn_listed()]), newest_turn),
    )
    .await;

    assert_eq!(
        adoption.answer_of(run_id),
        ProviderTurnAnswer::EndedByProvider
    );
    assert_eq!(turn_ends(&session.engine.calls()), (Vec::new(), Vec::new()));
    let established = adoption.established.expect("the session is established");
    assert_eq!(established.record.active_turn_run(CUT_TURN), Some(run_id));
    assert_eq!(established.record.active_turn_run(CONTINUATION_TURN), None);
}

// A continuation whose `turn/start` goes unanswered past its deadline may still have started:
// a second bare resume asks for the newest turn, and one no turn listed before the start names is
// held as the run's, which answers still running; a page holding only a listed turn answers the
// run gone. `turn/start` is sent once either way. Killed by `Gone` kept on a started turn, by a
// second `turn/start`, and by a listed turn taken as the new one.
#[rstest]
#[case::a_new_turn(page_turn(CONTINUATION_TURN, "inProgress", ROOT_TURN), true)]
#[case::a_listed_turn(cut_turn_listed(), false)]
#[tokio::test(start_paused = true)]
async fn a_continuation_start_left_unanswered_is_held_where_a_second_resume_shows_it(
    #[case] newest_turn: Value,
    #[case] is_started: bool,
) {
    let mut session = TestCodexSession::start_on(start_scripted_codex_service()).await;
    let run_id = new_run_id();

    let adoption = adopt(
        &mut session,
        vec![lead_run(run_id, RunState::Running)],
        AdoptionScript {
            is_loaded: false,
            status: "idle",
            resume_pages: vec![None, Some(json!([newest_turn]))],
            listed_turns: json!([cut_turn_listed()]),
            turn_start_answer: None,
            helpers: Vec::new(),
        },
    )
    .await;

    assert_eq!(adoption.turn_starts.len(), 1);
    let [_, check] = adoption.resumes.as_slice() else {
        panic!("a second resume is sent: {:?}", adoption.resumes);
    };
    assert_eq!(
        check["params"]["initialTurnsPage"],
        json!({"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"})
    );
    let established = adoption
        .established
        .as_ref()
        .expect("the session is established");
    if is_started {
        assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::StillRunning);
        assert_eq!(
            established.record.active_turn_run(CONTINUATION_TURN),
            Some(run_id)
        );
    } else {
        assert_eq!(adoption.answer_of(run_id), ProviderTurnAnswer::Gone);
        assert_eq!(established.record.newest_active_turn_for_run(run_id), None);
    }
}
