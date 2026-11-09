//! The adoption by handle the continuation tests drive: a lead run standing with its cut turn
//! open, the service's scripted answers to each resume, page, listing and turn start, and what the
//! adoption sent and answered.

use serde_json::{Value, json};
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::codex::session::establishment::CodexEstablishedSession;
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::session_control::held_run_continue::HeldRunContinue;
use crate::driver::session_control::{
    DriverResumeResult, LiveRunResume, OpenTurnResume, ProviderTurnAnswer,
};
use crate::driver::test_registry::new_session_id;
use crate::port::run_host::test_host::EngineCall;
use crate::run::turn_end::TurnOutcome;
use crate::runtime_binding::test_store::{
    binding_input, compose_test_resume_params, spawn_config_on, spawned_build,
    test_provider_account_id,
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
pub(super) const OTHER_ROOT_TURN: &str = "turn-other-root";

/// The cut turn's number within its run.
pub(super) const CUT_TURN_NUMBER: u64 = 2;

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
        model_id: None,
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
    pub(super) fn session_position(&self) -> u64 {
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
    pub(super) fn unloaded(listed_turns: Value, turn_start_answer: Value) -> Self {
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
    Box::pin(adopt_continuing(session, live_runs, None, answers)).await
}

// Adopts as `adopt` does, the resume carrying `held_run_continue`.
pub(super) async fn adopt_continuing(
    session: &mut TestCodexSession,
    live_runs: Vec<LiveRunResume>,
    held_run_continue: Option<HeldRunContinue>,
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
    let mut params = compose_test_resume_params(new_session_id(), &binding, live_runs);
    params.held_run_continue = held_run_continue;
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
                (Some("config/read"), _) => {
                    script.answer(&sent, &json!({"config": {}, "origins": {}}));
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

/// The model each helper's resume names.
pub(super) const HELPER_MODEL: &str = "gpt-5.4-mini";

// Answers `helper`'s resume `sent` with its page and [`HELPER_MODEL`], or with its refusal.
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
            "model": HELPER_MODEL,
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
