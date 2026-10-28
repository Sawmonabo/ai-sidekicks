//! What each live Claude session declared, and what is read from it: the provider's command and
//! skill surface from `system/init`, and its output-speed state from the `initialize` reply,
//! replaced by each later `system/init` that reports one and settled once per run when the run's
//! own handshake arrives.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup, ProviderCommandEntry,
};
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_COMMAND_NAME_MAX_LEN, PROVIDER_DECLARED_TOKEN_MAX_LEN,
};
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use crate::declared_output_speed::{DeclaredOutputSpeed, read_declared_output_speed};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeSessionUnavailableReason};
use crate::driver::claude::session::state::{ClaudeHeldHandshake, LiveClaudeSession};
use crate::driver::claude::session::transport::declarations::{
    ClaudeFastModeDeclaration, ClaudeHandshakeDeclaration,
};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

// The scope a command Claude Code runs only in its own terminal screen is listed with.
const TERMINAL_COMMAND_SCOPE: &str = "terminal";

/// A run whose output speed settled on its process's handshake, with the state the process declared
/// it runs at; the run engine compares it with the level the run carried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeSettledOutputSpeed {
    /// The run.
    pub(crate) run_id: RunId,
    /// The state the process runs it at.
    pub(crate) state: ProviderOutputSpeedState,
}

// One session's latest fast-mode reading, stamped with the provider session it was read under;
// `None` where the provider reported no state or one the contract's bounds refuse.
struct ClaudeHeldFastMode {
    provider_session_id: String,
    state: Option<ProviderOutputSpeedState>,
}

// The run whose output speed settles on its session's next handshake, stamped likewise.
struct ClaudeUnsettledRun {
    provider_session_id: String,
    run_id: RunId,
}

// What one live session declared.
#[derive(Default)]
struct ClaudeSessionDeclarations {
    handshake: Option<ClaudeHeldHandshake>,
    fast_mode: Option<ClaudeHeldFastMode>,
    unsettled_run: Option<ClaudeUnsettledRun>,
}

/// Holds each live session's handshake declaration, its latest fast-mode declaration and the run
/// whose output speed has yet to settle, never persisted: each stamped with the provider session
/// id it was read under and discarded with the session. Its lock is never held across an await.
#[derive(Default)]
pub(crate) struct ClaudeHandshakeRegister {
    sessions: Mutex<HashMap<SessionId, ClaudeSessionDeclarations>>,
}

impl ClaudeHandshakeRegister {
    /// Records one `system/init` declaration; the last wins, since the surface can change mid-run.
    /// A declaration reporting a fast-mode state replaces the held one; one reporting none keeps
    /// it. Answers the armed run's settled output speed, since the handshake of the turn the run
    /// started means whatever level it applied has taken effect.
    pub(crate) fn observe_handshake_declaration(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
        declaration: ClaudeHandshakeDeclaration,
    ) -> Option<ClaudeSettledOutputSpeed> {
        if declaration.fast_mode.fast_mode_state.is_some() {
            self.hold_fast_mode(session_id, provider_session_id, &declaration.fast_mode);
        }
        let invocable_command_names: HashSet<String> =
            declaration.slash_commands.iter().cloned().collect();
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .handshake = Some(ClaudeHeldHandshake {
            provider_session_id: provider_session_id.to_owned(),
            declaration,
            invocable_command_names,
        });
        self.settle_run_output_speed(session_id, provider_session_id)
    }

    /// Marks `run_id` as the run whose output speed settles on this process's next handshake; armed
    /// before the run's turn is written.
    pub(crate) fn arm_run_output_speed(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
        run_id: RunId,
    ) {
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .unsettled_run = Some(ClaudeUnsettledRun {
            provider_session_id: provider_session_id.to_owned(),
            run_id,
        });
    }

    /// Drops the armed run without a report: its turn was never written.
    pub(crate) fn disarm_run_output_speed(&self, session_id: SessionId) {
        if let Some(declarations) = lock(&self.sessions).get_mut(&session_id) {
            declarations.unsettled_run = None;
        }
    }

    /// Settles the armed run once, disarming it: answers the state the process holds, or `None`
    /// for another process's run, no armed run, or a process that never declared a state.
    pub(crate) fn settle_run_output_speed(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
    ) -> Option<ClaudeSettledOutputSpeed> {
        let mut sessions = lock(&self.sessions);
        let declarations = sessions.get_mut(&session_id)?;
        if declarations
            .unsettled_run
            .as_ref()
            .is_none_or(|unsettled| unsettled.provider_session_id != provider_session_id)
        {
            return None;
        }
        let unsettled = declarations.unsettled_run.take()?;
        let state = held_state(declarations.fast_mode.as_ref(), provider_session_id)?;
        Some(ClaudeSettledOutputSpeed {
            run_id: unsettled.run_id,
            state,
        })
    }

    /// Discards the session's declarations and armed run: live reads of a replaced process.
    pub(crate) fn forget_handshake(&self, session_id: SessionId) {
        lock(&self.sessions).remove(&session_id);
    }

    /// The handshake the process under `provider_session_id` declared, or `None` before it did.
    /// The stamp is a last guard behind registration clearing the record and retired channels
    /// being refused first.
    pub(crate) fn held_handshake_for(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
    ) -> Option<ClaudeHeldHandshake> {
        lock(&self.sessions)
            .get(&session_id)?
            .handshake
            .as_ref()
            .filter(|held| held.provider_session_id == provider_session_id)
            .cloned()
    }

    /// The output-speed state the provider last declared for one live session, from its
    /// `initialize` reply or a later `system/init`, or `None` where neither reported one. A
    /// declaration the contract's bounds refuse reads as absent; `cooldown` is carried as
    /// declared.
    pub(crate) fn observed_output_speed_for(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
    ) -> Option<ProviderOutputSpeedState> {
        held_state(
            lock(&self.sessions).get(&session_id)?.fast_mode.as_ref(),
            provider_session_id,
        )
    }

    /// Records the fast-mode state a process reported, in its `initialize` reply at spawn or in a
    /// handshake. Read once, as observed, so a declaration the bounds refuse records its
    /// diagnostic once.
    pub(crate) fn hold_fast_mode(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
        declaration: &ClaudeFastModeDeclaration,
    ) {
        let state = declaration.fast_mode_state.as_ref().and_then(|declared| {
            read_declared_output_speed(DeclaredOutputSpeed {
                provider: DESCRIPTOR.provider_id(),
                session_id,
                declared: Value::String(declared.clone()),
                reason: declaration.fast_mode_disabled_reason.clone(),
            })
        });
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .fast_mode = Some(ClaudeHeldFastMode {
            provider_session_id: provider_session_id.to_owned(),
            state,
        });
    }

    /// The command and skill entries one live session declared, all of them, stamped with
    /// `binding`'s provider and the account the session was admitted against, in one group with
    /// `run_id`; before the handshake, which rides a turn the person may not have made, it answers
    /// no entries. Fails with `Unavailable` (`ProviderAccountAmbiguous`) when `binding` names
    /// another account than the admitted one.
    pub(crate) fn enumerate_provider_commands(
        &self,
        session_id: SessionId,
        binding: ProviderCommandBinding,
        run_id: Option<RunId>,
        live: &LiveClaudeSession,
    ) -> Result<ProviderCommandBindingGroup, ClaudeSessionError> {
        let provider_account_id = resolve_stamped_account(
            session_id,
            live.admitted_provider_account_id.as_ref(),
            binding.provider_account_id,
        )?;
        let binding = ProviderCommandBinding {
            provider_name: binding.provider_name,
            provider_account_id,
        };
        let entries = self
            .held_handshake_for(session_id, &live.provider_session_id)
            .map(|held| compose_provider_command_entries(session_id, &held.declaration, &binding))
            .unwrap_or_default();
        Ok(ProviderCommandBindingGroup {
            run_id,
            binding,
            entries,
        })
    }
}

// The fast-mode state held for the process under `provider_session_id`, never another's.
fn held_state(
    fast_mode: Option<&ClaudeHeldFastMode>,
    provider_session_id: &str,
) -> Option<ProviderOutputSpeedState> {
    fast_mode
        .filter(|held| held.provider_session_id == provider_session_id)
        .and_then(|held| held.state.clone())
}

// The account an enumeration is stamped with: the admitted one, the record being primary and the
// registry a cross-check; with none admitted, the registry's. Two different accounts refuse, since
// the enumeration is routed by that identity and neither may silently win.
fn resolve_stamped_account(
    session_id: SessionId,
    admitted: Option<&ProviderAccountId>,
    registered: Option<ProviderAccountId>,
) -> Result<Option<ProviderAccountId>, ClaudeSessionError> {
    match (admitted, registered) {
        (None, registered) => Ok(registered),
        (Some(admitted), None) => Ok(Some(admitted.clone())),
        (Some(admitted), Some(registered)) if *admitted == registered => Ok(Some(registered)),
        (Some(admitted), Some(registered)) => Err(ClaudeSessionError::Unavailable {
            reason: ClaudeSessionUnavailableReason::ProviderAccountAmbiguous,
            detail: Some(format!(
                "The session was admitted against provider account {} while the daemon's \
                 account registry reports {}.",
                admitted.as_str(),
                registered.as_str()
            )),
            session_id: Some(session_id),
            run_id: None,
        }),
    }
}

// Composed at read time so the held declaration stays what the provider said. Each name is bounded
// by the entry's own checked text (a provider-supplied name may be blank, hold a NUL or run over
// the cap); a refused entry is dropped alone, with a diagnostic, so one bad name cannot empty the
// palette.
fn compose_provider_command_entries(
    session_id: SessionId,
    declaration: &ClaudeHandshakeDeclaration,
    binding: &ProviderCommandBinding,
) -> Vec<ProviderCommandEntry> {
    let terminal_scope: FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN> =
        FreeFormText::new(TERMINAL_COMMAND_SCOPE.to_owned())
            .expect("the terminal scope is a short word");
    let commands = declaration
        .slash_commands
        .iter()
        .map(|name| (name, ClaudeCommandKind::Command, None));
    let skills = declaration
        .skills
        .iter()
        .map(|name| (name, ClaudeCommandKind::Skill, None));
    // A command in kind; its scope records its terminal-only reach.
    let terminal_commands = declaration
        .terminal_slash_commands
        .iter()
        .map(|name| (name, ClaudeCommandKind::Command, Some(&terminal_scope)));
    commands
        .chain(skills)
        .chain(terminal_commands)
        .filter_map(|(name, kind, scope)| {
            let Ok(checked_name) = FreeFormText::<PROVIDER_COMMAND_NAME_MAX_LEN>::new(name.clone())
            else {
                report_rejected_entry(session_id, binding, kind, scope.is_some(), name);
                return None;
            };
            let binding = binding.clone();
            let scope = scope.cloned();
            Some(match kind {
                ClaudeCommandKind::Command => ProviderCommandEntry::Command {
                    name: checked_name,
                    description: None,
                    argument_hint: None,
                    scope,
                    enabled: None,
                    binding,
                    server: None,
                    title: None,
                },
                ClaudeCommandKind::Skill => ProviderCommandEntry::Skill {
                    name: checked_name,
                    description: None,
                    argument_hint: None,
                    scope,
                    enabled: None,
                    binding,
                    server: None,
                    title: None,
                },
            })
        })
        .collect()
}

// Which kind of entry a declared name becomes.
#[derive(Clone, Copy)]
enum ClaudeCommandKind {
    Command,
    Skill,
}

// Records an entry dropped for a name the entry's bounds refuse: the field and its length in code
// points, never the untrusted name.
fn report_rejected_entry(
    session_id: SessionId,
    binding: &ProviderCommandBinding,
    kind: ClaudeCommandKind,
    is_terminal: bool,
    name: &str,
) {
    let entry_kind = match kind {
        ClaudeCommandKind::Command => "command",
        ClaudeCommandKind::Skill => "skill",
    };
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: binding.provider_account_id.clone(),
        kind: DriverDiagnosticKind::ProviderCommandEntryRejected,
        raw_wire_type: None,
        disposition_reason: "the provider published a command or skill entry the contract's own \
                             bounds refuse; it is dropped from this reply and its siblings are \
                             unaffected"
            .to_owned(),
        details: [
            ("sessionId", json!(session_id)),
            ("entryKind", json!(entry_kind)),
            (
                "entryScope",
                json!(is_terminal.then_some(TERMINAL_COMMAND_SCOPE)),
            ),
            ("rejectedField", json!("name")),
            ("nameLength", json!(name.chars().count())),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect(),
    });
}
