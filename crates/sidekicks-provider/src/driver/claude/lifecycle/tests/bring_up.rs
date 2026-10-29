//! Bringing a session's process up: a failed start, the model check, a resume's place in its
//! conversation, and the handshake a resumed conversation reads.

use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderOptionSetting, ProviderOptionSettings, ProviderValue,
};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};

use sidekicks_platforms::RUNS_COMMAND_WRAPPER;

use super::resume_params;
use crate::command::channel::command_channel_root;
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::claude::session::scripted::channel::{
    ScriptedAnswer, ScriptedChannel, ScriptedWrite,
};
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, create_params};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, hand_scripted_frame, settle,
};
use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::session::transport::declarations::{
    ClaudeInitializeDeclaration, ClaudeOfferedModel,
};
use crate::driver::contract::ProviderDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::LeadBindingCheckParams;
use crate::driver::error_causes::ProviderAxis;
use crate::driver::session_control::{CloseSessionParams, CreateSessionParams, DriverResumeResult};
use crate::driver::test_registry::new_session_id;
use crate::run::posture::compose_execution_posture;

// Killed by a failed spawn that leaves the command channel it opened: its folder stays under the
// root, and the session's next spawn would take it as held.
#[tokio::test]
async fn a_channel_opened_for_a_spawn_that_fails_is_closed() {
    if !RUNS_COMMAND_WRAPPER {
        return;
    }
    let fixture = ScriptedDriver::new();
    fixture
        .services
        .ports
        .command_output
        .register(unbound_running_command_sets())
        .expect("the running commands register once");
    let session_id = new_session_id();
    fixture.starts.script_failed_session("the spawn failed");

    assert!(
        fixture
            .driver
            .create_session(create_params(session_id))
            .await
            .is_err()
    );

    let session_folder =
        command_channel_root(&fixture.services.data_folder).join(session_id.to_string());
    let left = match std::fs::read_dir(&session_folder) {
        Ok(entries) => entries.count(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => panic!("the session's channel folder reads: {error}"),
    };
    assert_eq!(left, 0, "the failed spawn's channel was left open");
}

// Killed by a failed bring-up leaving its claim behind, which refuses the next create, and by a
// close that finds a bring-up in flight returning before it settles, which leaves its process
// running with no session to close it.
#[tokio::test(start_paused = true)]
async fn a_failed_bring_up_frees_its_claim_and_a_close_waits_for_one_in_flight() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    fixture.starts.script_failed_session("the spawn failed");
    assert!(
        fixture
            .driver
            .create_session(create_params(session_id))
            .await
            .is_err()
    );
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release = fixture.starts.hold_next_session_start();
    let driver = Arc::clone(&fixture.driver);
    let create =
        tokio::spawn(async move { driver.create_session(create_params(session_id)).await });
    fixture.starts.wait_for_starts(1).await;
    let driver = Arc::clone(&fixture.driver);
    let close = tokio::spawn(async move {
        driver
            .close_session(CloseSessionParams { session_id })
            .await
    });
    settle().await;
    assert!(!channel.writes().contains(&ScriptedWrite::Terminate));

    drop(release);
    create
        .await
        .expect("the create runs")
        .expect("the create succeeds");
    close
        .await
        .expect("the close runs")
        .expect("the close succeeds");

    assert!(channel.writes().contains(&ScriptedWrite::Terminate));
    assert!(fixture.driver.starts_process(session_id));
}

// Killed by matching the session's model to the build's catalog exactly, which switches a listed
// model; by sending no switch for an unlisted one; and by refusing a model Claude Code will not
// run as an internal failure instead of naming the session's lead.
#[rstest]
#[case::listed_under_its_window_spelling(
    "claude-opus-4-6-1m",
    "claude-opus-4-6[1m]",
    false,
    Some(0)
)]
#[case::larger_window_unlisted("claude-opus-4-6[1m]", "claude-opus-4-6", false, Some(1))]
#[case::unlisted_and_refused("claude-opus-4-6[1m]", "claude-opus-4-6", true, None)]
#[tokio::test(start_paused = true)]
async fn a_new_session_switches_to_an_unlisted_model_and_refuses_one_claude_code_rejects(
    #[case] model: &str,
    #[case] listed: &str,
    #[case] is_refused: bool,
    #[case] switches: Option<usize>,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    if is_refused {
        channel.answer("set_model", ScriptedAnswer::Refused);
    }
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: listed.to_owned(),
                resolved_model: None,
                display_name: None,
                effort_levels: None,
            }],
            ..ClaudeInitializeDeclaration::default()
        });
    fixture.starts.script_session(Arc::clone(&channel));
    let params = CreateSessionParams {
        model: ProviderToken::new(model.to_owned()).expect("the model fits"),
        ..create_params(new_session_id())
    };
    let agent_id = params.agent_id;

    let created = fixture.driver.create_session(params).await;

    let model_switches = channel
        .control_requests()
        .iter()
        .filter(|request| request["subtype"] == "set_model")
        .count();
    if let Some(count) = switches {
        assert!(created.is_ok(), "the session opens");
        assert_eq!(model_switches, count);
    } else {
        let Err(DriverError::ProviderAxisInvalid(invalid)) = created else {
            panic!("a model Claude Code refuses is refused for the session's lead");
        };
        assert_eq!(invalid.agent_id, agent_id);
        assert_eq!(invalid.axis, ProviderAxis::ModelId);
        assert_eq!(invalid.value, Value::from(model));
        assert!(channel.writes().contains(&ScriptedWrite::Terminate));
    }
}

// Killed by a lead check that reads the catalog, which starts a process, or that passes an option
// the driver does not declare; by a start that takes an effort its listed model does not list; and
// by checking an effort against a model the catalog does not list, which Claude Code still runs.
#[rstest]
#[case::listed_effort("opus", "high", None)]
#[case::effort_its_model_does_not_list("opus", "max", Some(ProviderAxis::Effort))]
#[case::unlisted_model("claude-unlisted", "max", None)]
#[tokio::test(start_paused = true)]
async fn the_lead_check_reads_nothing_and_the_start_refuses_an_effort_its_model_does_not_list(
    #[case] model: &str,
    #[case] effort: &str,
    #[case] refused: Option<ProviderAxis>,
) {
    let fixture = ScriptedDriver::new();
    let params = CreateSessionParams {
        model: ProviderToken::new(model.to_owned()).expect("the model fits"),
        effort: Some(ProviderToken::new(effort.to_owned()).expect("the effort fits")),
        ..create_params(new_session_id())
    };
    let agent_id = params.agent_id;
    let check = |options| {
        fixture.driver.check_lead_binding(LeadBindingCheckParams {
            agent_id,
            model_id: params.model.clone(),
            effort: params.effort.clone(),
            options,
        })
    };
    check(None).expect("the model and the effort wait for the start");
    let undeclared = ProviderOptionSettings::new(vec![ProviderOptionSetting {
        id: ProviderDeclarationId::new("undeclared".to_owned()).expect("the id fits"),
        value: ProviderValue::Switch(true),
    }]);
    let Err(DriverError::ProviderAxisInvalid(invalid)) = check(undeclared) else {
        panic!("an option the driver does not declare is refused");
    };
    assert_eq!(invalid.axis, ProviderAxis::Options);
    assert!(fixture.starts.take_catalog_environments().is_empty());
    assert!(fixture.starts.take_started().is_empty());

    let channel = Arc::new(ScriptedChannel::default());
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            models: vec![ClaudeOfferedModel {
                value: "opus".to_owned(),
                resolved_model: None,
                display_name: None,
                effort_levels: Some(vec!["low".to_owned(), "high".to_owned()]),
            }],
            ..ClaudeInitializeDeclaration::default()
        });
    fixture.starts.script_session(Arc::clone(&channel));
    let created = fixture.driver.create_session(params).await;

    match refused {
        None => assert!(created.is_ok(), "the session opens"),
        Some(axis) => {
            let Err(DriverError::ProviderAxisInvalid(invalid)) = created else {
                panic!("an effort the model does not list is refused for the session's lead");
            };
            assert_eq!(invalid.agent_id, agent_id);
            assert_eq!(invalid.axis, axis);
            assert_eq!(invalid.value, Value::from(effort));
            assert!(channel.writes().contains(&ScriptedWrite::Terminate));
        }
    }
}

// Killed by reading a conversation file that cannot be read as one with no turns, which resumes
// the session at the wrong place in it, and by failing a resume whose conversation has no file
// yet.
#[rstest]
#[case::no_file_yet(false)]
#[case::unreadable_file(true)]
#[tokio::test(start_paused = true)]
async fn a_resume_starts_at_its_conversations_turn_count_and_fails_on_an_unreadable_file(
    #[case] is_unreadable: bool,
) {
    let fixture = ScriptedDriver::new();
    if is_unreadable {
        // A folder where the conversation's file would be is found and cannot be read.
        let file = fixture
            .home
            .join(".claude/projects/work/conversation.jsonl");
        std::fs::create_dir_all(file).expect("the folder is made");
    }
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    let resumed = fixture
        .driver
        .resume_session(resume_params(new_session_id()))
        .await
        .expect("the resume answers");

    match resumed {
        DriverResumeResult::Resumed {
            session_position, ..
        } => {
            assert!(
                !is_unreadable,
                "an unreadable conversation fails the resume"
            );
            assert_eq!(session_position.get(), 0);
        }
        DriverResumeResult::Failed { .. } => {
            assert!(is_unreadable, "a conversation with no file yet resumes");
            assert!(fixture.starts.take_started().is_empty());
        }
    }
}

// Killed by keeping a process's handshake past its end: a resume that reuses the conversation's
// id would read the old process's declaration before its new process declares one.
#[tokio::test(start_paused = true)]
async fn a_resumed_conversation_reads_no_handshake_until_its_new_process_declares_one() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let parts = fixture.driver.composed_parts().expect("composed");
    let (routes, handshakes) = (&parts.run_start.routes, &parts.run_start.handshakes);
    let handle = resume_params(session_id).resume_handle;
    let init =
        json!({"type": "system", "subtype": "init", "session_id": SCRIPTED_PROVIDER_SESSION_ID});
    let resume = async || {
        fixture
            .starts
            .script_session(Arc::new(ScriptedChannel::default()));
        let resumed = fixture
            .driver
            .resume_session(resume_params(session_id))
            .await
            .expect("the resume answers");
        assert!(matches!(resumed, DriverResumeResult::Resumed { .. }));
        fixture.next_start().await
    };
    let first = resume().await;
    hand_scripted_frame(&*first.listener, routes, session_id, &init);
    assert!(handshakes.held_handshake_for(session_id, &handle).is_some());
    fixture
        .driver
        .close_session(CloseSessionParams { session_id })
        .await
        .expect("the close succeeds");
    settle().await;

    let second = resume().await;

    assert!(handshakes.held_handshake_for(session_id, &handle).is_none());
    hand_scripted_frame(&*second.listener, routes, session_id, &init);
    assert!(handshakes.held_handshake_for(session_id, &handle).is_some());
}

// Killed by starting every process in its level's own mode, which drops a stored Plan until a
// later move, and by naming Plan for a session in Build.
#[rstest]
#[case::plan(SessionMode::Plan, Some(ClaudePermissionMode::Plan))]
#[case::build(SessionMode::Build, None)]
#[tokio::test(start_paused = true)]
async fn a_new_session_starts_in_the_mode_it_stores(
    #[case] mode: SessionMode,
    #[case] permission_mode: Option<ClaudePermissionMode>,
) {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));

    fixture
        .driver
        .create_session(CreateSessionParams {
            mode,
            ..create_params(new_session_id())
        })
        .await
        .expect("the session opens");

    assert_eq!(fixture.next_start().await.permission_mode, permission_mode);
    let mode_requests = channel
        .control_requests()
        .iter()
        .filter(|request| request["subtype"] == "set_permission_mode")
        .count();
    assert_eq!(mode_requests, 0);
}

// Killed by answering a level the started process cannot run as an internal failure, or by
// adopting the process at it.
#[tokio::test(start_paused = true)]
async fn a_new_session_at_a_level_its_model_cannot_run_is_refused_as_not_offered() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    let created = fixture
        .driver
        .create_session(CreateSessionParams {
            execution_posture: Some(compose_execution_posture(
                PermissionLevel::Reviewed,
                FilesystemPath::new("/".to_owned()).expect("the root is a path"),
            )),
            ..create_params(session_id)
        })
        .await;

    let Err(DriverError::Refused(refusal)) = created else {
        panic!("a level the model cannot run is refused, not {created:?}");
    };
    assert_eq!(refusal.code, RefusalCode::SessionPermissionLevelNotOffered);
    assert!(fixture.driver.starts_process(session_id));
}
