//! What each live Claude session declared, and what is read from it: the provider's command and
//! skill surface from `system/init`, and its output-speed state from the `initialize` reply,
//! replaced by each later `system/init` that reports one and settled once per run when the run's
//! own handshake arrives. A session at rest has its commands and agents read afresh, concurrent
//! reads of one session on one account offering the same helpers sharing one process and nothing
//! kept once it settles.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandBindingGroup, ProviderCommandEntry,
};
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_COMMAND_DESCRIPTION_MAX_LEN, PROVIDER_COMMAND_NAME_MAX_LEN,
    PROVIDER_DECLARED_TOKEN_MAX_LEN, PROVIDER_MCP_SERVER_NAME_MAX_LEN,
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
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::initialize_reply::ClaudeListedCommand;
use crate::driver::claude::spawn::launch::session_listing::ClaudeSessionListing;
use crate::driver::contract::error::DriverError;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::session_control::SubagentDefinition;

// The scope a command Claude Code runs only in its own terminal screen is listed with.
const TERMINAL_COMMAND_SCOPE: &str = "terminal";

// The end of the name Claude Code lists a tool server's prompt under, as `server:prompt (MCP)`.
const CLAUDE_PROMPT_NAME_SUFFIX: &str = " (MCP)";

// One resting listing read as it starts, before it is shared.
type ClaudeRestingListingStart =
    BoxFuture<'static, Result<ClaudeSessionListing, ClaudeLaunchError>>;

// One read of a resting session's listing, which every concurrent read of the session offering the
// same helpers awaits; its failure, answered as a start's, is shared, so it is held behind an
// `Arc`.
type ClaudeRestingListingRead =
    Shared<BoxFuture<'static, Result<ClaudeSessionListing, Arc<DriverError>>>>;

// The session and the account one resting listing read runs on, since each account lists its own
// user-level commands and agents.
type ClaudeRestingReadKey = (SessionId, ProviderAccountId);

// One resting listing read in flight and the helpers its process was offered, which its agents
// answer, so only a read offering the same helpers joins it.
struct ClaudeRestingListingFlight {
    offered_helpers: Vec<SubagentDefinition>,
    read: ClaudeRestingListingRead,
}

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
    // Each resting session's listing reads in flight on each account, each gone once it settles.
    resting_reads: Arc<Mutex<HashMap<ClaudeRestingReadKey, Vec<ClaudeRestingListingFlight>>>>,
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

    /// Holds `commands`, the list the `initialize` reply of the process under
    /// `provider_session_id` declared, as its handshake's invocable commands, so the process lists
    /// them before its first message brings `system/init`, whose declaration then replaces it.
    pub(crate) fn hold_initialize_commands(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
        commands: &[String],
    ) {
        lock(&self.sessions)
            .entry(session_id)
            .or_default()
            .handshake = Some(ClaudeHeldHandshake {
            provider_session_id: provider_session_id.to_owned(),
            invocable_command_names: commands.iter().cloned().collect(),
            declaration: ClaudeHandshakeDeclaration {
                slash_commands: commands.to_vec(),
                ..ClaudeHandshakeDeclaration::default()
            },
        });
    }

    /// Takes `commands`, a whole `/` list Claude Code sent again, in place of the commands the
    /// held declaration of the process under `provider_session_id` listed; a list from another
    /// process, or before any declaration, changes nothing.
    pub(crate) fn replace_commands(
        &self,
        session_id: SessionId,
        provider_session_id: &str,
        commands: &[String],
    ) {
        let mut sessions = lock(&self.sessions);
        let Some(held) = sessions
            .get_mut(&session_id)
            .and_then(|declarations| declarations.handshake.as_mut())
            .filter(|held| held.provider_session_id == provider_session_id)
        else {
            return;
        };
        held.declaration.slash_commands = commands.to_vec();
        held.invocable_command_names = commands.iter().cloned().collect();
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

    /// The listing read of resting `session_id` on `provider_account_id`'s account offering
    /// `offered` in flight, else the one `start` begins. The read runs to its end whoever still
    /// waits on it, so a dropped caller leaves no process behind, and it is forgotten as it
    /// settles, so the next read starts afresh. Fails, for every waiter, as a session's start
    /// fails for the same failure.
    pub(crate) fn join_resting_listing_read(
        &self,
        session_id: SessionId,
        provider_account_id: ProviderAccountId,
        offered: &[SubagentDefinition],
        start: impl FnOnce() -> ClaudeRestingListingStart,
    ) -> impl Future<Output = Result<ClaudeSessionListing, DriverError>> {
        let key = (session_id, provider_account_id);
        let mut reads = lock(&self.resting_reads);
        let flights = reads.entry(key.clone()).or_default();
        let read = if let Some(flight) = flights
            .iter()
            .find(|flight| flight.offered_helpers == offered)
        {
            flight.read.clone()
        } else {
            let held = Arc::clone(&self.resting_reads);
            let held_offered = offered.to_vec();
            let read = start()
                .map(move |listing| {
                    // The only flight offering these helpers until this removes it: a read is
                    // begun only where none is held.
                    let mut reads = lock(&held);
                    if let Some(flights) = reads.get_mut(&key) {
                        flights.retain(|flight| flight.offered_helpers != held_offered);
                        if flights.is_empty() {
                            reads.remove(&key);
                        }
                    }
                    listing.map_err(|error| Arc::new(DriverError::from(error)))
                })
                .boxed()
                .shared();
            flights.push(ClaudeRestingListingFlight {
                offered_helpers: offered.to_vec(),
                read: read.clone(),
            });
            drop(tokio::spawn(read.clone()));
            read
        };
        read.map(|listing| listing.map_err(|failure| DriverError::shared(&failure)))
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
            &live.admitted_provider_account_id(),
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
// registry a cross-check. Two different accounts refuse, since the enumeration is routed by that
// identity and neither may silently win.
fn resolve_stamped_account(
    session_id: SessionId,
    admitted: &ProviderAccountId,
    registered: ProviderAccountId,
) -> Result<ProviderAccountId, ClaudeSessionError> {
    if *admitted == registered {
        return Ok(registered);
    }
    Err(ClaudeSessionError::Unavailable {
        reason: ClaudeSessionUnavailableReason::ProviderAccountAmbiguous,
        detail: Some(format!(
            "The session was admitted against provider account {} while the daemon's account \
             registry reports {}.",
            admitted.as_str(),
            registered.as_str()
        )),
        session_id: Some(session_id),
        run_id: None,
    })
}

// Composed at read time so the held declaration stays what the provider said.
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
            compose_command_entry(session_id, binding, kind, scope, name, None, None)
        })
        .collect()
}

/// The entries of a resting session's command list as `rows` lists them, in order, each stamped
/// with `binding`: a row named `server:prompt (MCP)` is that server's prompt, and every other row
/// a command, since the list does not say which rows are skills. A row whose name or server the
/// entry's bounds refuse is dropped alone, with a diagnostic.
pub(crate) fn compose_resting_command_entries(
    session_id: SessionId,
    binding: &ProviderCommandBinding,
    rows: &[ClaudeListedCommand],
) -> Vec<ProviderCommandEntry> {
    rows.iter()
        .filter_map(|row| {
            let (kind, name) = match read_prompt_name(&row.name) {
                Some((server, prompt)) => (ClaudeCommandKind::Prompt { server }, prompt),
                None => (ClaudeCommandKind::Command, row.name.as_str()),
            };
            compose_command_entry(
                session_id,
                binding,
                kind,
                None,
                name,
                row.description.as_deref(),
                row.argument_hint.as_deref(),
            )
        })
        .collect()
}

// The server and prompt of a name Claude Code lists as `server:prompt (MCP)`; `None` for any other.
fn read_prompt_name(name: &str) -> Option<(&str, &str)> {
    let (server, prompt) = name
        .strip_suffix(CLAUDE_PROMPT_NAME_SUFFIX)?
        .split_once(':')?;
    (!server.is_empty() && !prompt.is_empty()).then_some((server, prompt))
}

// One entry, each field bounded by the entry's own checked text, since what the provider supplies
// may be blank, hold a NUL or run over the cap. A refused name or server drops the entry alone, so
// one bad row cannot empty the palette; a refused description or hint reads absent, the entry
// kept. Each refusal is recorded.
fn compose_command_entry(
    session_id: SessionId,
    binding: &ProviderCommandBinding,
    kind: ClaudeCommandKind<'_>,
    scope: Option<&FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>>,
    name: &str,
    description: Option<&str>,
    argument_hint: Option<&str>,
) -> Option<ProviderCommandEntry> {
    let rejected = |field: &'static str, value: Option<&str>| {
        report_rejected_entry(
            session_id,
            binding,
            kind,
            scope.is_some(),
            field,
            name,
            value,
        );
    };
    let Ok(checked_name) = FreeFormText::<PROVIDER_COMMAND_NAME_MAX_LEN>::new(name.to_owned())
    else {
        rejected("name", None);
        return None;
    };
    let optional = |field: &'static str, text: Option<&str>| {
        let text = text?;
        let checked = FreeFormText::<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>::new(text.to_owned());
        if checked.is_err() {
            rejected(field, Some(text));
        }
        checked.ok()
    };
    let description = optional("description", description);
    let argument_hint = optional("argumentHint", argument_hint);
    let binding = binding.clone();
    let scope = scope.cloned();
    Some(match kind {
        ClaudeCommandKind::Command => ProviderCommandEntry::Command {
            name: checked_name,
            description,
            argument_hint,
            scope,
            enabled: None,
            binding,
            server: None,
            title: None,
        },
        ClaudeCommandKind::Skill => ProviderCommandEntry::Skill {
            name: checked_name,
            description,
            argument_hint,
            scope,
            enabled: None,
            binding,
            server: None,
            title: None,
        },
        ClaudeCommandKind::Prompt { server } => {
            let Ok(server) =
                FreeFormText::<PROVIDER_MCP_SERVER_NAME_MAX_LEN>::new(server.to_owned())
            else {
                rejected("server", Some(server));
                return None;
            };
            ProviderCommandEntry::Prompt {
                name: checked_name,
                description,
                argument_hint,
                scope,
                enabled: None,
                binding,
                server,
                title: None,
            }
        }
    })
}

// Which kind of entry a listed name becomes; a prompt names the server that publishes it.
#[derive(Clone, Copy)]
enum ClaudeCommandKind<'a> {
    Command,
    Skill,
    Prompt { server: &'a str },
}

// Records a field the entry's bounds refuse, and whether the entry was dropped for it: the field
// and the lengths in code points of the name and of the refused value, never the untrusted text.
fn report_rejected_entry(
    session_id: SessionId,
    binding: &ProviderCommandBinding,
    kind: ClaudeCommandKind<'_>,
    is_terminal: bool,
    field: &'static str,
    name: &str,
    value: Option<&str>,
) {
    let entry_kind = match kind {
        ClaudeCommandKind::Command => "command",
        ClaudeCommandKind::Skill => "skill",
        ClaudeCommandKind::Prompt { .. } => "prompt",
    };
    let is_dropped = matches!(field, "name" | "server");
    let disposition_reason = if is_dropped {
        "the provider published a command, skill or prompt entry the contract's own bounds \
         refuse; it is dropped from this reply and its siblings are unaffected"
    } else {
        "the provider published a command, skill or prompt field the contract's own bounds \
         refuse; the entry is kept and the field reads absent"
    };
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(binding.provider_account_id.clone()),
        kind: DriverDiagnosticKind::ProviderCommandEntryRejected,
        raw_wire_type: None,
        disposition_reason: disposition_reason.to_owned(),
        details: [
            ("sessionId", json!(session_id)),
            ("entryKind", json!(entry_kind)),
            (
                "entryScope",
                json!(is_terminal.then_some(TERMINAL_COMMAND_SCOPE)),
            ),
            ("rejectedField", json!(field)),
            ("dropped", json!(is_dropped)),
            ("nameLength", json!(name.chars().count())),
            (
                "rejectedValueLength",
                json!(value.map(|value| value.chars().count())),
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect(),
    });
}

#[cfg(test)]
mod tests {
    use futures::FutureExt;
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use super::{ClaudeHandshakeRegister, ClaudeRestingListingStart};
    use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeUnansweredCause};
    use crate::driver::claude::session::transport::control::ClaudeControlSubtype;
    use crate::driver::claude::spawn::launch::ClaudeLaunchError;
    use crate::driver::claude::spawn::launch::session_listing::ClaudeSessionListing;
    use crate::driver::contract::error::DriverError;
    use crate::driver::test_registry::new_session_id;

    fn sign_in_refused() -> ClaudeLaunchError {
        ClaudeLaunchError::Session(ClaudeSessionError::AuthenticationRequired {
            detail: "Not logged in".to_owned(),
        })
    }

    fn initialize_unanswered() -> ClaudeLaunchError {
        ClaudeLaunchError::Session(ClaudeSessionError::Unanswered {
            subtype: ClaudeControlSubtype::Initialize,
            cause: ClaudeUnansweredCause::Deadline,
        })
    }

    fn account(account_id: &str) -> ProviderAccountId {
        ProviderAccountId::new(account_id.to_owned()).expect("an account id fits")
    }

    fn spawn_failed() -> ClaudeLaunchError {
        ClaudeLaunchError::Spawn(std::io::Error::other("no such program"))
    }

    // How a waiter's failure answers: its kind, and the code a client reads.
    fn answer_of(error: &DriverError) -> (&'static str, Option<RefusalCode>) {
        if let DriverError::Refused(refusal) = error {
            ("refused", Some(refusal.code))
        } else if let DriverError::Unanswered(unanswered) = error {
            ("unanswered", Some(unanswered.refusal.code))
        } else if let DriverError::Internal(_) = error {
            ("internal", None)
        } else {
            ("other", None)
        }
    }

    // Killed by a failed read answered as internal, for the read's own waiter or one that joined
    // it, and by a failure that keeps its kind but not its code.
    #[rstest]
    #[case::a_refused_sign_in(
        sign_in_refused,
        ("refused", Some(RefusalCode::ProviderAccountNotAuthenticated))
    )]
    #[case::no_answer_in_time(
        initialize_unanswered,
        ("unanswered", Some(RefusalCode::ProviderTimeout))
    )]
    #[case::a_failed_start(spawn_failed, ("internal", None))]
    #[tokio::test]
    async fn every_waiter_on_a_failed_resting_read_gets_a_start_s_answer(
        #[case] failure: fn() -> ClaudeLaunchError,
        #[case] expected: (&'static str, Option<RefusalCode>),
    ) {
        let register = ClaudeHandshakeRegister::default();
        let session_id = new_session_id();

        let first =
            register.join_resting_listing_read(session_id, account("account-1"), &[], || {
                async move { Err(failure()) }.boxed()
            });
        let second = register.join_resting_listing_read(
            session_id,
            account("account-1"),
            &[],
            || -> ClaudeRestingListingStart {
                unreachable!("a second read joins the one in flight")
            },
        );

        for answer in [first.await, second.await] {
            let error = answer.expect_err("the read failed");
            assert_eq!(answer_of(&error), expected);
        }
    }

    // Killed by a key without the account: the second account's read joins the first's failed
    // one and answers its sign-in refusal instead of its own list.
    #[tokio::test]
    async fn a_resting_read_on_another_account_starts_its_own_process() {
        let register = ClaudeHandshakeRegister::default();
        let session_id = new_session_id();

        let first =
            register.join_resting_listing_read(session_id, account("account-1"), &[], || {
                async move { Err(sign_in_refused()) }.boxed()
            });
        let second =
            register.join_resting_listing_read(session_id, account("account-2"), &[], || {
                async move { Ok(ClaudeSessionListing::default()) }.boxed()
            });

        first.await.expect_err("the first account's read failed");
        assert_eq!(
            second.await.expect("the second account's read is its own"),
            ClaudeSessionListing::default()
        );
    }
}
