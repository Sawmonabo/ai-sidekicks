//! A naming pass on a resting Claude Code session whose one turn never answers.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::CLAUDE_NAMING_DEADLINE;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::connectors::{
    ClaudeAccountServerAnswers, ClaudeAccountServersReadRequest,
};
use crate::driver::claude::mcp::sign_in::{ClaudeMcpSignInChannel, ClaudeMcpSignInStart};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeModelCatalogReading, ClaudeReplyReserveReads,
    ClaudeSessionFolderReadRequest,
};
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::bring_up::ClaudeBringUpRequest;
use crate::driver::claude::spawn::launch::installed_build::{
    ClaudeProcessStarts, ClaudeStartedSession,
};
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnReply, ClaudeOneTurnRequest};
use crate::driver::contract::{DriverError, GetCapabilitiesResult};
use crate::driver::session_control::NameSessionParams;
use crate::driver::test_registry::new_session_id;

/// What a naming pass at rest never starts.
const ONLY_THE_ONE_TURN: &str = "a naming pass at rest starts only its one turn";

// A one-turn process that never answers: it runs until its stop fires, which it keeps.
#[derive(Default)]
struct UnansweredOneTurn {
    stop: Mutex<Option<CancellationToken>>,
    started: Notify,
}

impl ClaudeProcessStarts for UnansweredOneTurn {
    fn start_session<'a>(
        &'a self,
        _request: ClaudeBringUpRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeStartedSession, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn read_creation_figures(
        &self,
        _place: ClaudeSessionFolderReadRequest,
        _read_models: HashSet<String>,
    ) -> BoxFuture<'static, Result<ClaudeCreationFiguresReading, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn read_reply_reserve(
        &self,
        _place: ClaudeSessionFolderReadRequest,
    ) -> BoxFuture<'static, Result<ClaudeReplyReserveReads, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn run_one_turn<'a>(
        &'a self,
        request: ClaudeOneTurnRequest<'a>,
    ) -> BoxFuture<'a, Result<ClaudeOneTurnReply, ClaudeLaunchError>> {
        *sidekicks_std::mutex_lock::lock(&self.stop) = Some(request.stop.clone());
        self.started.notify_one();
        async move {
            request.stop.cancelled().await;
            Err(ClaudeLaunchError::TurnStopped)
        }
        .boxed()
    }

    fn probe_sign_in(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<String, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn read_model_catalog(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<ClaudeModelCatalogReading, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn read_capabilities(
        &self,
        _environment: Vec<(String, String)>,
    ) -> BoxFuture<'_, Result<GetCapabilitiesResult, DriverError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn read_account_servers(
        &self,
        _request: ClaudeAccountServersReadRequest,
    ) -> BoxFuture<'_, Result<ClaudeAccountServerAnswers, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn start_mcp_sign_in(
        &self,
        _start: ClaudeMcpSignInStart,
    ) -> BoxFuture<'_, Result<ClaudeMcpSignInChannel, ClaudeLaunchError>> {
        unreachable!("{ONLY_THE_ONE_TURN}")
    }

    fn stop_every_process(&self) -> BoxFuture<'_, ()> {
        async {}.boxed()
    }
}

// Killed by removing the pass's deadline: the one turn would run until the caller's cancel.
#[tokio::test]
async fn a_naming_pass_whose_one_turn_never_answers_ends_with_none_at_its_deadline() {
    let fixture = ScriptedDriver::new();
    let one_turn = Arc::new(UnansweredOneTurn::default());
    let driver = ClaudeDriver::with_starts(&fixture.services, Arc::clone(&one_turn) as _);
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account, "stored-conversation");
    let cancel = CancellationToken::new();
    let params = NameSessionParams {
        session_id,
        place: None,
        first_message: "Fix the login page".to_owned(),
        first_reply: "Looking at the form.".to_owned(),
        cancel: cancel.clone(),
    };
    let started = one_turn.started.notified();
    let pass = tokio::spawn(async move { driver.name_session(params).await });
    // The clock stops once the one turn runs, past the reads before it on other threads.
    started.await;
    tokio::time::pause();
    let stop = sidekicks_std::mutex_lock::lock(&one_turn.stop)
        .clone()
        .expect("the one turn ran");

    tokio::time::advance(CLAUDE_NAMING_DEADLINE.saturating_sub(Duration::from_secs(1))).await;
    assert!(!stop.is_cancelled(), "the one turn runs until the deadline");
    tokio::time::advance(Duration::from_secs(1)).await;
    let named = tokio::time::timeout(Duration::from_secs(1), pass)
        .await
        .expect("the pass ends at its deadline")
        .expect("the pass's task ends");

    assert_eq!(named.expect("a pass past its deadline names nothing"), None);
    assert!(stop.is_cancelled(), "the one turn's process was stopped");
    assert!(!cancel.is_cancelled(), "the caller's cancel is left alone");
}
