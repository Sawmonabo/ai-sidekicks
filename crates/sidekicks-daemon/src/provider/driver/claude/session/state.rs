//! The per-session state the Claude driver keeps: the live session, the handshake it declared,
//! its routing band, and the slot each session occupies, from a process coming up to one whose
//! disposal failed.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::SetOnce;

use crate::provider::callback_tools::spawn_binding::CallbackToolSpawnBinding;
use crate::provider::driver::claude::session::answered_commands::{
    ClaudeAttachedAdvisor, ClaudeCommandChoices,
};
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::declarations::{
    ClaudeHandshakeDeclaration, ClaudeInboundFrameObservation, ClaudeInitializeDeclaration,
};
use crate::provider::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::provider::driver::claude::session::ultracode::ClaudeUltracodeReading;
use crate::provider::thread_frame_router::{
    RoutableProviderFrame, ThreadFrameFamilyClass, ThreadFrameRouter, ThreadFrameRouterConfig,
};
use crate::provider::usage_delta_accountant::UsageDeltaAccountant;
use crate::queue::delivery::ProviderProcessIdentity;

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
}

/// What a session's process was started with, kept so a later run is checked against it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ClaudeSpawnBinding {
    /// The whole posture, so every axis can be compared.
    pub(crate) execution_posture: Option<ExecutionPosture>,
    /// The digest of the output schema it binds.
    pub(crate) output_schema_digest: Option<String>,
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
    /// The advisor model, `None` when off.
    pub(crate) advisor_model: Option<String>,
    /// The session's own output style, `None` where Claude Code's own setting holds.
    pub(crate) output_style: Option<String>,
    /// The model the session runs on; a relaunch and a fork pass this one as `--model`.
    pub(crate) running_model: String,
    /// The advisor Claude Code says it attaches, read after the start and after each change.
    #[expect(
        dead_code,
        reason = "the Claude driver's relaunch and controls read it"
    )]
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
    /// The provider session the process runs under.
    pub(crate) provider_session_id: String,
    /// The process.
    pub(crate) channel: Arc<dyn ClaudeProcessChannel>,
    /// What the process was started with, for a later run's check.
    pub(crate) spawn_binding: ClaudeSpawnBinding,
    /// The legs the process was started with; a rewind starts its fork from these, since
    /// deriving them again would guess, and a guess without the posture runs unsandboxed.
    pub(crate) spawn_bound_legs: ClaudeSpawnBoundLegs,
    /// What the process's `initialize` reply declared.
    pub(crate) initialize: ClaudeInitializeDeclaration,
    /// The style descriptions and advisors Claude Code offers, kept across a rewind.
    #[expect(dead_code, reason = "the Claude driver's session task reads it")]
    pub(crate) command_choices: ClaudeHeldCommandChoices,
    /// The usage base.
    #[expect(
        dead_code,
        reason = "the Claude driver's stream reader meters usage from it"
    )]
    pub(crate) establishment: ClaudeUsageEstablishment,
    /// The account the process was admitted against, captured when it came up, since the
    /// registry can move; a rewind inherits it. `None` on the machine's own home.
    pub(crate) admitted_provider_account_id: Option<ProviderAccountId>,
    /// What the session runs with now.
    pub(crate) settings: Mutex<ClaudeLiveSettings>,
    /// The process's identity in the daemon's spawn count, removed from the process registry at
    /// its exit.
    pub(crate) process_identity: ProviderProcessIdentity,
    /// The spawn's callback-tool registry, released once no process of the session holds it; a
    /// rewind's fork shares its predecessor's.
    pub(crate) callback_tool_binding: Arc<CallbackToolSpawnBinding>,
    /// The exit the process ended with, set once it ended, for a rewind's predecessor whose exit
    /// is taken up only once its fork fails.
    pub(crate) process_exit: OnceLock<ProcessExit>,
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
    },
    /// The disposal failed, so the process still lives and this is the only handle on it, kept
    /// until a later close disposes of it.
    Quarantined {
        /// The process.
        channel: Arc<dyn ClaudeProcessChannel>,
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
    use crate::provider::driver::claude::session::scripted::scripted_live_session;
    use crate::provider::driver::claude::session::transport::channel::MockClaudeProcessChannel;

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
