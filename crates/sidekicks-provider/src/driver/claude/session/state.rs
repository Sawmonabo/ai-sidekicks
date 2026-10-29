//! The per-session state the Claude driver keeps: the live session, the handshake it declared,
//! its routing band, and the slot each session occupies, from a process coming up to one whose
//! disposal failed.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::machine::settings::ProviderRowValues;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::SetOnce;

use crate::callback_tools::spawn_binding::CallbackToolSpawnBinding;
use crate::driver::claude::DESCRIPTOR;

use crate::driver::claude::frame_routing::ClaudeThreadUsageTally;
use crate::driver::claude::session::answered_commands::{
    ClaudeAttachedAdvisor, ClaudeCommandChoices,
};
use crate::driver::claude::session::mcp_server_readings::ClaudeMcpServerReadings;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::declarations::{
    ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation, ClaudeInitializeDeclaration,
};
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::session::ultracode::ClaudeUltracodeReading;
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::params_and_results::SpawnedVersionBindingCarriers;
use crate::port::reviewer_denial::ReviewerDenialPort;
use crate::process_identity::ProviderProcessIdentity;
use crate::thread_frame_router::{
    RoutableProviderFrame, ThreadFrameFamilyClass, ThreadFrameRouter, ThreadFrameRouterConfig,
};
use crate::usage_delta_accountant::UsageDeltaAccountant;

/// The router's bounds. The hold covers a helper's frames arriving ahead of its start; the short
/// timeout means a frame held longer names a helper never announced.
pub(crate) const CLAUDE_THREAD_FRAME_ROUTER_CONFIG: ThreadFrameRouterConfig =
    ThreadFrameRouterConfig {
        max_quarantined_frames: 64,
        max_pending_hold_frames: 128,
        pending_registration_timeout: Duration::from_secs(5),
    };

/// One process's `system/init` declaration, stamped with the provider session id it was read
/// under: a rewind forks a new process behind the same session, so a read checks the stamp and
/// answers as unread rather than with the old process's declaration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeHeldHandshake {
    /// The provider session the declaration was read under.
    pub(crate) provider_session_id: String,
    /// The declaration.
    pub(crate) declaration: ClaudeHandshakeDeclaration,
    /// The command names invocable over this transport: `slash_commands` only.
    pub(crate) invocable_command_names: HashSet<String>,
}

/// One frame as the thread-frame router sees it. Claude Code's frames carry no thread id, so the
/// thread is the helper's id or else the provider session id, never none, which would quarantine
/// every ordinary frame.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeRoutableFrame {
    /// The helper's id, or the provider session id.
    pub(crate) thread_id: String,
    /// The frame's family.
    pub(crate) family_class: ThreadFrameFamilyClass,
    /// The observation the frame was built from, so a released hold can still be metered.
    pub(crate) observation: ClaudeInboundFrameObservation,
}

impl RoutableProviderFrame for ClaudeRoutableFrame {
    fn raw_wire_type(&self) -> &str {
        &self.observation.frame_kind
    }

    fn family_class(&self) -> ThreadFrameFamilyClass {
        self.family_class
    }

    fn thread_id(&self) -> Option<&str> {
        Some(&self.thread_id)
    }
}

/// A session's router and accountant, held together so no frame routes to an unmetered thread.
pub(crate) struct ClaudeSessionRoutingBand {
    /// The router.
    pub(crate) router: ThreadFrameRouter<ClaudeRoutableFrame>,
    /// The accountant.
    pub(crate) accountant: UsageDeltaAccountant,
    /// Each thread's usage as its messages sum it.
    pub(crate) usage_tally: ClaudeThreadUsageTally,
}

impl ClaudeSessionRoutingBand {
    /// A band for one process, with no thread registered yet.
    pub(crate) fn new() -> Self {
        Self {
            router: ThreadFrameRouter::new(
                DESCRIPTOR.provider_id(),
                CLAUDE_THREAD_FRAME_ROUTER_CONFIG,
            ),
            accountant: UsageDeltaAccountant::new(DESCRIPTOR.provider_id()),
            usage_tally: ClaudeThreadUsageTally::default(),
        }
    }
}

/// What a session's process was started with, kept so a later run is checked against it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeSpawnBinding {
    /// The whole posture, so every axis can be compared.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The digest of the output schema it binds.
    pub(crate) output_schema_digest: Option<String>,
}

/// What a process was asked to start with where it runs something else: the callback tools before
/// the host trims them to the ones it offers, and the Settings rows before the session's own
/// advisor and style override them. A relaunch asks for these again, and a resume that finds the
/// process up compares its own request against them.
#[derive(Clone, Debug, Default)]
pub(crate) struct ClaudeRequestedSpawn {
    /// The callback tools requested.
    pub(crate) callback_tools: Option<Vec<SessionCallbackTool>>,
    /// The Settings values the app stored for the provider.
    pub(crate) row_values: ProviderRowValues,
}

/// The usage base a session's counts are measured from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeUsageEstablishment {
    /// Zero.
    Fresh,
    /// The sums already reported under `prior_emitted_thread_id`, which after a rewind is the
    /// predecessor's, since the fork announces a new one.
    Resume {
        /// The thread the sums were reported under.
        prior_emitted_thread_id: String,
    },
}

/// The style descriptions and advisors a session holds, read beside its first process and shared
/// by every later session on its folder; it never fails, an unreadable read holding why.
pub(crate) type ClaudeHeldCommandChoices = Shared<BoxFuture<'static, ClaudeCommandChoices>>;

/// What a live session runs with now, each the process's start value until the session changes
/// it; every process started for the session carries these. Its lock is never held across an
/// await.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeLiveSettings {
    /// The posture the session runs at; a relaunch starts at this one.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// Whether the next turns build or plan; a fresh process builds.
    pub(crate) session_mode: SessionMode,
    /// The session's advisor, the one Claude Code resolved at the start where none was picked.
    pub(crate) advisor: ClaudeSessionAdvisor,
    /// The session's own output style, `None` where Claude Code's own setting holds.
    pub(crate) output_style: Option<String>,
    /// The model the session runs on; a relaunch and a fork pass this one as `--model`.
    pub(crate) running_model: String,
    /// The advisor Claude Code says it attaches, read after the start and after each change.
    pub(crate) attached_advisor: ClaudeAttachedAdvisor,
    /// The output-speed level the process last took, which a rewind applies to its fork; `None`
    /// when it took none.
    pub(crate) applied_output_speed: Option<String>,
    /// The Ultracode value the agent asked for, which a relaunch starts with; `None` keeps Claude
    /// Code's own.
    pub(crate) ultracode_requested: Option<bool>,
    /// Ultracode's state as Claude Code last reported it.
    pub(crate) ultracode: Option<ClaudeUltracodeReading>,
}

/// A session whose Claude Code process is running, with the legs it was started with.
pub(crate) struct LiveClaudeSession {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's lead, which a relaunch resumes as.
    pub(crate) agent_id: AgentId,
    /// The provider session the process runs under.
    pub(crate) provider_session_id: String,
    /// The process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// What the process was started with, for a later run's check.
    pub(crate) spawn_binding: ClaudeSpawnBinding,
    /// What the process was asked to start with where it runs something else, which a rewind's
    /// fork inherits.
    pub(crate) requested_spawn: ClaudeRequestedSpawn,
    /// The legs the process was started with; a rewind starts its fork from these, since
    /// deriving them again would guess, and a guess without the posture runs unsandboxed.
    pub(crate) spawn_bound_legs: ClaudeSpawnBoundLegs,
    /// What the process's `initialize` reply declared.
    pub(crate) initialize: ClaudeInitializeDeclaration,
    /// The style descriptions and advisors Claude Code offers, kept across a rewind.
    pub(crate) command_choices: ClaudeHeldCommandChoices,
    /// The account the process was admitted against, captured when it came up, since the
    /// registry can move; a rewind inherits it.
    pub(crate) admitted_provider_account_id: ProviderAccountId,
    /// What the session runs with now.
    pub(crate) settings: Mutex<ClaudeLiveSettings>,
    /// The build that runs the process, which a resume that found it already up answers.
    pub(crate) spawned_version: SpawnedVersionBindingCarriers,
    /// The binding the resume that brought the process up answered, which a resume that finds it
    /// already up answers again; `None` for a create's or a fork's, whose binding the daemon holds.
    pub(crate) resumed_binding_id: Option<RuntimeBindingId>,
    /// The process's identity in the daemon's spawn count, removed from the process registry at
    /// its exit.
    pub(crate) process_identity: ProviderProcessIdentity,
    /// The spawn's callback-tool registry, released once no process of the session holds it; a
    /// rewind's fork shares its predecessor's.
    pub(crate) callback_tool_binding: Arc<CallbackToolSpawnBinding>,
    /// The exit the process ended with, set once it ended, for a rewind's predecessor whose exit
    /// is taken up only once its fork fails.
    pub(crate) process_exit: OnceLock<ProcessExit>,
    /// Set once the process's task has ended: after its `Exit` arrival, by when the task has taken
    /// whole every arrival its reader queued before the exit, or on an abort or a panic.
    pub(crate) task_ended: SetOnce<()>,
    /// The binding of each run that took the session's turn on this process, whose held `Allow
    /// once` presses are released once the process is gone, ended runs' included.
    pub(crate) served_bindings: Mutex<HashSet<RuntimeBindingId>>,
    /// The socket the process listens on, the path the daemon chose and passed it at its start;
    /// `None` where none could be made.
    pub(crate) messaging_socket: Option<PathBuf>,
    /// The last reading of each MCP server the process reported, and whether its leg ended.
    pub(crate) mcp_server_readings: Mutex<ClaudeMcpServerReadings>,
}

impl LiveClaudeSession {
    /// Records that a run on `binding_id` took the session's turn on this process.
    pub(crate) fn record_served_binding(&self, binding_id: RuntimeBindingId) {
        lock(&self.served_bindings).insert(binding_id);
    }

    /// Releases the held `Allow once` presses of every binding this process served, through
    /// `reviewer_denials` once the approvals are registered, and forgets them, once the process is
    /// gone or no longer the session's.
    pub(crate) fn release_served_presses(
        &self,
        reviewer_denials: &PortRegistration<Arc<dyn ReviewerDenialPort>>,
    ) {
        let Some(reviewer_denials) = reviewer_denials.port() else {
            return;
        };
        let served = std::mem::take(&mut *lock(&self.served_bindings));
        for binding_id in &served {
            reviewer_denials.release_held_presses(binding_id);
        }
    }
}

/// A slot's transition in flight, set once its slot write is made or the transition ends without
/// it; a waiter then reads the slot again.
pub(crate) type ClaudeSlotSettled = Arc<SetOnce<()>>;

/// One session's slot. No slot is Empty, the only state a create or resume may start from; every
/// other state is held in one registry so a slot mid-disposal never reads as Empty.
#[derive(Clone)]
pub(crate) enum ClaudeSessionSlot {
    /// A create, resume or rewind is bringing a process up. A rewind keeps the session it forks
    /// from, whose frames stay attributable during the fork and which a failed fork restores.
    Establishing {
        /// The bring-up.
        settled: ClaudeSlotSettled,
        /// The session a rewind forks from; `None` for a create or resume.
        predecessor: Option<Arc<LiveClaudeSession>>,
    },
    /// A process is up; the only state a run starts in.
    Live {
        /// The session.
        session: Arc<LiveClaudeSession>,
    },
    /// The process is being disposed of; Empty once that succeeds, Quarantined when it fails.
    Closing {
        /// The disposal.
        settled: ClaudeSlotSettled,
        /// The process's channel until it closes, whose frames read meanwhile still reach the
        /// session, so a `result` read during the close ends its turn; `None` once it closed.
        reading: Option<Arc<dyn ClaudeProcessChannel>>,
    },
    /// The disposal failed, so the process still lives and this is the only handle on it, kept
    /// with the bindings it served until a later close disposes of it.
    Quarantined {
        /// The session whose process it is.
        session: Arc<LiveClaudeSession>,
    },
}

impl ClaudeSessionSlot {
    /// The slot once a bring-up from this one failed: a rewind's predecessor is live again, and a
    /// create or resume leaves the slot Empty (`None`); any other slot is left as it is.
    pub(crate) fn after_failed_bring_up(self) -> Option<Self> {
        match self {
            Self::Establishing {
                predecessor: Some(session),
                ..
            } => Some(Self::Live { session }),
            Self::Establishing {
                predecessor: None, ..
            } => None,
            slot @ (Self::Live { .. } | Self::Closing { .. } | Self::Quarantined { .. }) => {
                Some(slot)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use tokio::sync::SetOnce;

    use super::{ClaudeSessionSlot, LiveClaudeSession};
    use crate::driver::claude::session::scripted::scripted_live_session;
    use crate::driver::claude::session::transport::channel::MockClaudeProcessChannel;

    fn live_session() -> Arc<LiveClaudeSession> {
        let session_id =
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id");
        Arc::new(scripted_live_session(
            session_id,
            Arc::new(MockClaudeProcessChannel::new()),
        ))
    }

    // Killed by a failed rewind that empties the slot, losing a live process, or by a failed
    // create that leaves a slot behind.
    #[test]
    fn a_failed_rewind_restores_its_predecessor_and_a_failed_create_empties_the_slot() {
        let predecessor = live_session();
        let settled = Arc::new(SetOnce::new());

        let rewound = ClaudeSessionSlot::Establishing {
            settled: settled.clone(),
            predecessor: Some(Arc::clone(&predecessor)),
        }
        .after_failed_bring_up();
        let created = ClaudeSessionSlot::Establishing {
            settled,
            predecessor: None,
        }
        .after_failed_bring_up();

        assert!(matches!(
            rewound,
            Some(ClaudeSessionSlot::Live { session }) if Arc::ptr_eq(&session, &predecessor)
        ));
        assert!(created.is_none());
    }
}
