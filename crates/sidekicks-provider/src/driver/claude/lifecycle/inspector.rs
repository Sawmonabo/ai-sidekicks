//! The Claude Code driver's reads of a session's Memory and Hooks sections, answered from the
//! session's live process and what its processes showed, never starting one.

use serde_json::Value;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::inspector::{
    SessionHookListResponse, SessionMemoryEntry, SessionMemoryEntryKind, SessionMemoryHomeScope,
    SessionMemoryReadResponse,
};

use super::{ClaudeDriver, internal};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::establishment::spawn_sources::claude_account_config_folder;
use crate::driver::claude::session::inspector_reads::ClaudeKeptHookListing;
use crate::driver::claude::session::memory::{
    CLAUDE_AUTO_MEMORY_SETTING, CLAUDE_AUTO_MEMORY_VARIABLE, ClaudeAutoMemorySources,
    read_claude_auto_memory,
};
use crate::driver::claude::session::settings_file::read_claude_setting;
use crate::driver::claude::spawn::environment::claude_text_variable;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::session_inspector::InspectedSession;

impl ClaudeDriver {
    /// The session's Memory section: the memory files its last context read named and the store
    /// folders its last process declared, in its account's own config folder, with its `Auto
    /// memory` switch. A live process's context is read again first, joining a read under way.
    /// Fails as the account's folders, a settings file or the config folder's path cannot be read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the driver interface's memory read calls it")
    )]
    pub(crate) async fn read_session_memory(
        &self,
        session: &InspectedSession,
    ) -> Result<SessionMemoryReadResponse, DriverError> {
        let session_id = session.session_id;
        let parts = self.composed_parts();
        if let Some(parts) = parts
            && let Some(live) = parts.slots().live_session(session_id)
        {
            parts
                .establishment
                .task_services
                .context_readings
                .read_for_opening(&live)
                .await;
        }
        let kept =
            parts.and_then(|parts| parts.establishment.inspector_reads.kept_memory(session_id));
        let environment = match self.last_conversation(session_id) {
            Some(conversation) => conversation.spawn_environment,
            None => {
                self.sources
                    .account_environment(&session.provider_account_id)
                    .await?
            }
        };
        let reading = self
            .sources
            .read_settings_sources(&environment, &session.working_folder)
            .await?;
        let setting = read_claude_setting(
            &reading.sources(),
            &[CLAUDE_AUTO_MEMORY_SETTING],
            Value::as_bool,
        )
        .await
        .map_err(internal)?;
        let (running, kept_value) = split_process_auto_memory(
            self.session_process_state(session_id),
            kept.as_ref().and_then(|kept| kept.auto_memory),
        );
        let auto_memory = read_claude_auto_memory(&ClaudeAutoMemorySources {
            running,
            stored_switch: session.auto_memory,
            kept: kept_value,
            variable: claude_text_variable(&environment, CLAUDE_AUTO_MEMORY_VARIABLE),
            setting,
        });
        let home = FilesystemPath::new(
            claude_account_config_folder(&environment)
                .to_string_lossy()
                .into_owned(),
        )
        .map_err(internal)?;
        let entries = kept
            .iter()
            .flat_map(|kept| {
                let files = kept
                    .files
                    .iter()
                    .map(|file| (file, SessionMemoryEntryKind::File));
                let stores = kept
                    .stores
                    .iter()
                    .map(|store| (store, SessionMemoryEntryKind::Folder));
                files.chain(stores)
            })
            .map(|(path, kind)| SessionMemoryEntry {
                path: path.clone(),
                kind,
            })
            .collect();
        Ok(SessionMemoryReadResponse {
            session_id,
            home,
            home_scope: SessionMemoryHomeScope::Account,
            auto_memory,
            entries,
            listed_at_next_start: kept.is_none(),
        })
    }

    /// The session's Hooks section: the listing its last process gave after its start, waiting
    /// only while that listing is under way; never a listing of its own. Fails when that process
    /// listed nothing the daemon could read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the driver interface's hooks read calls it")
    )]
    pub(crate) async fn list_session_hooks(
        &self,
        session: &InspectedSession,
    ) -> Result<SessionHookListResponse, DriverError> {
        let session_id = session.session_id;
        let listing = match self.composed_parts() {
            Some(parts) => {
                parts
                    .establishment
                    .inspector_reads
                    .kept_hook_listing(session_id)
                    .await
            }
            None => ClaudeKeptHookListing::NoProcess,
        };
        match listing {
            ClaudeKeptHookListing::NoProcess => Ok(SessionHookListResponse::ListedAtNextStart {
                session_id,
                provider: DESCRIPTOR.provider_id(),
                folders: None,
                hooks: None,
                errors: None,
                policy: None,
            }),
            ClaudeKeptHookListing::Listed(response) => Ok(response),
            ClaudeKeptHookListing::Unread => Err(DriverError::Internal(
                format!(
                    "the Claude Code process of session {session_id} listed no hooks the daemon \
                     could read"
                )
                .into(),
            )),
        }
    }
}

// The process value `value` as the running one while a process serves the session or a restart
// brings one back, since that process runs with it, else as the kept one: `(running, kept)`.
fn split_process_auto_memory(
    state: SessionProcessState,
    value: Option<bool>,
) -> (Option<bool>, Option<bool>) {
    match state {
        SessionProcessState::Live | SessionProcessState::Restarting => (value, None),
        SessionProcessState::Down => (None, value),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::inspector::SessionAutoMemory;

    use super::*;

    // Killed by `Restarting` read as kept, and by `Down` read as running.
    #[rstest]
    #[case::live(
        SessionProcessState::Live,
        SessionAutoMemory { enabled: true, enabled_at_next_turn: Some(false) }
    )]
    #[case::restarting(
        SessionProcessState::Restarting,
        SessionAutoMemory { enabled: true, enabled_at_next_turn: Some(false) }
    )]
    #[case::down(
        SessionProcessState::Down,
        SessionAutoMemory { enabled: false, enabled_at_next_turn: None }
    )]
    fn a_process_value_runs_while_a_process_serves_or_comes_back(
        #[case] state: SessionProcessState,
        #[case] read: SessionAutoMemory,
    ) {
        let (running, kept) = split_process_auto_memory(state, Some(true));
        assert_eq!(
            read_claude_auto_memory(&ClaudeAutoMemorySources {
                running,
                stored_switch: Some(false),
                kept,
                variable: None,
                setting: None,
            }),
            read
        );
    }
}
