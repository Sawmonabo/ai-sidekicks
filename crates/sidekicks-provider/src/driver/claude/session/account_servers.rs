//! When each account's connectors and organization servers are read, and what is kept between
//! reads: an account is read when it is first asked for after the daemon starts, again on a
//! refresh, and at a session's start after a failed or short read, one read per account at a time,
//! a second ask while one runs joining it, and the result kept for the account until a refresh,
//! each connector marked from its organization's connector list.
//! Budget: one Claude Code process of about 140 to 150 MB per account at a time, and none once the
//! account's result is kept; a failed read, or one that still lacked a connector its list holds,
//! is kept for a plain list until the account's next session or refresh asks again, so a plain
//! list never starts a process for an account read before.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;

use crate::driver::claude::mcp::connectors::organization_mark::ClaudeOrganizationMarks;
use crate::driver::claude::mcp::connectors::{
    ClaudeAccountServersReadRequest, read_claude_account_answers, read_claude_account_servers,
};
use crate::driver::claude::mcp::machine_probe::probe_ceiling;
use crate::driver::claude::mcp::precedence::ClaudeMcpAccountServers;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::establishment::spawn_sources::ClaudeSpawnSources;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::contract::error::DriverError;
use crate::driver::diagnostics::DriverDiagnosticKind;

/// The folder under an account's home its read's process runs in, kept empty.
const CLAUDE_ACCOUNT_SERVERS_READ_FOLDER: &str = "account-mcp-read";

/// Who asks for an account's read, which decides whether a kept failure is read again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeAccountReadAsk {
    /// A plain list, which joins a kept result, a short one included, or a kept failure.
    List,
    /// A session's start, which reads again after a kept failure or a kept short result.
    SessionStart,
    /// A refresh, which always reads again unless a read runs.
    Refresh,
}

/// One account's read, running or done: every ask of it gets the one result.
pub(crate) type ClaudeAccountServersRead =
    Shared<BoxFuture<'static, Result<Arc<ClaudeMcpAccountServers>, Arc<DriverError>>>>;

/// Each account's read of its connectors and organization servers, held by the driver.
pub(crate) struct ClaudeAccountServerReads {
    starts: Arc<dyn ClaudeProcessStarts>,
    sources: Arc<ClaudeSpawnSources>,
    marks: Arc<ClaudeOrganizationMarks>,
    reads: Mutex<HashMap<ProviderAccountId, ClaudeAccountServersRead>>,
}

impl ClaudeAccountServerReads {
    /// The reads, each starting its process through `starts` on the account's home `sources`
    /// resolve, and marking its connectors through `marks`.
    pub(crate) fn new(
        starts: Arc<dyn ClaudeProcessStarts>,
        sources: Arc<ClaudeSpawnSources>,
        marks: ClaudeOrganizationMarks,
    ) -> Self {
        Self {
            starts,
            sources,
            marks: Arc::new(marks),
            reads: Mutex::default(),
        }
    }

    /// Starts `provider_account_id`'s read at a session's start, unless one runs or its result is
    /// kept; the session never waits on it, and a failure is recorded.
    pub(crate) fn read_at_session_start(&self, provider_account_id: &ProviderAccountId) {
        drop(self.read(provider_account_id, ClaudeAccountReadAsk::SessionStart));
    }

    /// `provider_account_id`'s read for `ask`: the running one; else the kept result or failure
    /// for a plain list; else the kept result for a session's start unless it lacked a listed
    /// connector; else a new read started now, which runs to its end whether or not the caller
    /// awaits it. Resolves to the account's servers, or the error the read failed with.
    pub(crate) fn read(
        &self,
        provider_account_id: &ProviderAccountId,
        ask: ClaudeAccountReadAsk,
    ) -> ClaudeAccountServersRead {
        let mut reads = lock(&self.reads);
        if let Some(read) = reads.get(provider_account_id) {
            let is_joined = match (read.peek(), ask) {
                (None, _) | (Some(_), ClaudeAccountReadAsk::List) => true,
                (Some(Ok(servers)), ClaudeAccountReadAsk::SessionStart) => {
                    !servers.lacks_listed_connectors
                }
                (Some(Err(_)), ClaudeAccountReadAsk::SessionStart)
                | (Some(_), ClaudeAccountReadAsk::Refresh) => false,
            };
            if is_joined {
                return read.clone();
            }
        }
        let task = tokio::spawn(read_account(
            Arc::clone(&self.starts),
            Arc::clone(&self.sources),
            Arc::clone(&self.marks),
            provider_account_id.clone(),
        ));
        let read = async move {
            match task.await {
                Ok(result) => result.map(Arc::new).map_err(Arc::new),
                Err(error) => Err(Arc::new(DriverError::Internal(Box::new(error)))),
            }
        }
        .boxed()
        .shared();
        reads.insert(provider_account_id.clone(), read.clone());
        read
    }
}

// One read: the account's environment, its process in the empty folder under its home, and the
// answers read on it, its connectors' organization marks read once it reported its version. A
// failure is recorded here, since a read a session started has no one to tell.
async fn read_account(
    starts: Arc<dyn ClaudeProcessStarts>,
    sources: Arc<ClaudeSpawnSources>,
    marks: Arc<ClaudeOrganizationMarks>,
    provider_account_id: ProviderAccountId,
) -> Result<ClaudeMcpAccountServers, DriverError> {
    let read = async {
        let environment = sources.account_environment(&provider_account_id).await?;
        let account_home =
            claude_config_folder(&environment, PathRules::NATIVE).ok_or_else(|| {
                DriverError::Internal("the account's Claude Code home is not named".into())
            })?;
        let channel = starts
            .start_account_servers_read(ClaudeAccountServersReadRequest {
                environment: environment.clone(),
                provider_account_id: provider_account_id.clone(),
                working_folder: account_home.join(CLAUDE_ACCOUNT_SERVERS_READ_FOLDER),
            })
            .await?;
        let read = read_claude_account_answers(
            &*channel,
            async |build_version: Option<String>| {
                marks.read(&environment, build_version.as_deref()).await
            },
            probe_ceiling(&environment),
        )
        .await;
        channel.close().await;
        let (answers, marks) = read?;
        Ok(read_claude_account_servers(
            &provider_account_id,
            &answers,
            marks.as_ref(),
        ))
    }
    .await;
    if let Err(error) = &read {
        record_unheard_claude_failure(
            DriverDiagnosticKind::ControlOnlyReadFailed,
            None,
            "the account read of Claude Code's connectors and organization servers",
            error,
        );
    }
    read
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use futures::FutureExt;
    use futures::future::ready;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;
    use sidekicks_platforms::CredentialStore;
    use sidekicks_std::mutex_lock::lock;

    use super::{ClaudeAccountReadAsk, ClaudeAccountServerReads};
    use crate::driver::claude::account_credentials::ClaudeSignInReader;
    use crate::driver::claude::mcp::connectors::organization_mark::ClaudeOrganizationMarks;
    use crate::driver::claude::mcp::precedence::ClaudeMcpAccountServers;
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::contract::error::DriverError;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Two reads of one account asked while the first is held both get its result from one
    // process. Killed by a read that starts its own process for an account already being read.
    #[tokio::test]
    async fn a_second_read_of_an_account_joins_the_running_one() {
        let fixture = ScriptedDriver::new();
        fixture.starts.script_account_servers(
            json!({ "mcpServers": [{
                "name": "claude.ai Notes",
                "scope": "claudeai",
                "config": { "type": "claudeai-proxy", "url": "https://notes.example.com/mcp" }
            }] }),
            json!({}),
        );
        let release = fixture.starts.hold_next_account_servers_read();
        let reads = ClaudeAccountServerReads::new(
            fixture.starts.clone(),
            Arc::clone(&fixture.driver.sources),
            ClaudeOrganizationMarks::new(ClaudeSignInReader::with_keychain(
                CredentialStore::in_memory(),
            )),
        );
        let account = test_provider_account_id();

        let first = reads.read(&account, ClaudeAccountReadAsk::List);
        let second = reads.read(&account, ClaudeAccountReadAsk::List);
        drop(release);
        let (first, second) = tokio::join!(first, second);

        assert_eq!(fixture.starts.take_account_servers_read_count(), 1);
        for servers in [first, second] {
            let servers = servers.expect("the read answers");
            let [connector] = servers.connectors.as_slice() else {
                panic!("one connector: {:?}", servers.connectors);
            };
            assert!(matches!(
                &connector.binding,
                McpServerBindingRef::Connector { scope_ref, .. } if *scope_ref == account
            ));
        }
    }

    // A failed read, and one that still lacked a connector its list holds, is kept for a plain
    // list, which starts no process for it, until a session's start asks again. Killed by a plain
    // list reading either again, and by a session's start joining either.
    #[rstest]
    #[case::failed(false)]
    #[case::short_of_its_connector_list(true)]
    #[tokio::test]
    async fn a_kept_failure_or_short_read_is_read_again_only_when_a_session_starts(
        #[case] is_short: bool,
    ) {
        let fixture = ScriptedDriver::new();
        let reads = ClaudeAccountServerReads::new(
            fixture.starts.clone(),
            Arc::clone(&fixture.driver.sources),
            ClaudeOrganizationMarks::new(ClaudeSignInReader::with_keychain(
                CredentialStore::in_memory(),
            )),
        );
        let account = test_provider_account_id();
        let kept = if is_short {
            Ok(Arc::new(ClaudeMcpAccountServers {
                provider_account_id: account.clone(),
                organization_servers: Vec::new(),
                connectors: Vec::new(),
                connector_readings: Vec::new(),
                organization_readings: Vec::new(),
                organization_entries: BTreeMap::new(),
                lacks_listed_connectors: true,
            }))
        } else {
            Err(Arc::new(DriverError::Internal(
                "the account read failed".into(),
            )))
        };
        lock(&reads.reads).insert(account.clone(), ready(kept).boxed().shared());

        for _ in 0..2 {
            let read = reads.read(&account, ClaudeAccountReadAsk::List).await;
            assert_eq!(read.is_ok(), is_short);
        }
        assert_eq!(fixture.starts.take_account_servers_read_count(), 0);

        let read = reads
            .read(&account, ClaudeAccountReadAsk::SessionStart)
            .await;
        assert!(read.is_ok_and(|servers| !servers.lacks_listed_connectors));
        assert_eq!(fixture.starts.take_account_servers_read_count(), 1);
    }
}
