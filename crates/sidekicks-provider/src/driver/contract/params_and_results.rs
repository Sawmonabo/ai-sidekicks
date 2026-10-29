//! The params the daemon hands a driver operation and the results the driver answers with.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderOptionSetting, ProviderValue,
};
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::commands::ProviderCommandBinding;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::driver::tools::ProviderToolMetadata;
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::driver::capabilities::{DriverCapabilities, DriverCapabilityFlag};
use crate::driver::run_control::PickedSkill;
use crate::port::permission_ask::ProviderPermissionAnswer;

/// Where a session's provider process stands, as its driver holds it: the one predicate the
/// session controls choose their arm by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionProcessState {
    /// A process serves the session now; a control reaches it at once.
    Live,
    /// No process serves the session now, and the driver itself brings one back from the state it
    /// holds, with no open or resume by the daemon. A level or mode move the driver accepts in
    /// this window reaches the process it brings back; the daemon stores it as on a live session.
    Restarting,
    /// No process serves the session, and none starts until the daemon's open or resume, which
    /// reads the stored mode and level: never opened in this daemon, asleep, closed, or stopped
    /// restarting after a crash loop.
    Down,
}

/// A follow of a session's live command list, ended when this drops.
#[must_use = "the command list is followed only while the subscription lives"]
pub struct ProviderCommandsSubscription {
    /// Ends the follow; taken once, on drop.
    end: Option<Box<dyn FnOnce() + Send>>,
}

impl ProviderCommandsSubscription {
    /// A subscription that runs `end` once when it drops.
    pub(crate) fn new(end: impl FnOnce() + Send + 'static) -> Self {
        Self {
            end: Some(Box::new(end)),
        }
    }
}

impl Drop for ProviderCommandsSubscription {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end();
        }
    }
}

/// One declared row's new value, already checked against its declaration and stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyRowValueParams {
    /// The row.
    pub row_id: ProviderDeclarationId,
    /// The place of a per-place switch; `None` on a computer without a WSL 2 distribution or for a
    /// row that is not per place.
    pub place: Option<Place>,
    /// The value, or `None` for a choice's none.
    pub value: Option<ProviderValue>,
}

/// What the daemon hands a driver to start one run: its id, the message that opens it and the
/// run's own options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartRunParams {
    /// The run.
    pub run_id: RunId,
    /// The queued message the run opens with, on the binding the daemon opened for it.
    pub opening: RunOpening,
    /// The conversation so far, for a provider that takes it per run.
    pub conversation_history: Option<Vec<Value>>,
    /// The agent's accepted output-speed level, resolved as on [`CreateSessionParams`]. A provider
    /// that applies it between turns sends it before this run's turn only when it differs from
    /// the level the process last applied; one that takes it per turn sends it with this turn.
    /// `None` keeps the level the process holds.
    pub output_speed: Option<ProviderToken>,
    /// The session option values to apply between turns before this run's turn, like
    /// `outputSpeed`; an option left out keeps what the process holds.
    pub options: Vec<ProviderOptionSetting>,
    /// A level for this run's turn alone; the next run carries the agent's own level again.
    pub output_speed_for_turn: Option<ProviderToken>,
    /// The run's effective posture. A provider that binds posture at spawn meets a change by
    /// relaunching the session, never by applying part of it.
    pub execution_posture: Option<ExecutionPosture>,
    /// A JSON Schema this turn's final output must meet (gated on `structuredOutput`), for a
    /// provider that binds it per turn.
    pub output_schema: Option<Map<String, Value>>,
    /// The session's own bound on the steps one turn may take, read as the run starts; `None`
    /// where the person set none.
    pub step_bound: Option<SafeInt<1>>,
}

/// The queued item a run the queue admitted opens with, and where it runs: the session, the
/// binding its deliveries are attributed on and the agent whose run it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOpening {
    /// The session.
    pub session_id: SessionId,
    /// The runtime binding the run's deliveries are attributed on, opened by the daemon.
    pub binding_id: RuntimeBindingId,
    /// The agent whose run it is.
    pub agent_id: AgentId,
    /// The queued item's id, stamped on the provider's user message so a later cut can name it.
    pub message_id: QueueItemId,
    /// What the run's turn opens with.
    pub item: RunOpeningItem,
}

/// What a run the queue admitted opens its turn with: a message the person sent, or the
/// provider's own review of the session's changes, which runs as the run's turn and whose report
/// lands as the agent's reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunOpeningItem {
    /// A message.
    Message {
        /// The message's words.
        content: MessageContent,
        /// The message's files, in staging order.
        attachments: Vec<ArtifactId>,
        /// The skills picked for the message, in the order picked.
        skills: Vec<PickedSkill>,
    },
    /// The provider's own review.
    Review {
        /// What the review covers.
        target: SessionReviewTarget,
    },
}

/// Answers one interactive request a driver raised on a run with the daemon's answer, which the
/// driver composes into its provider's own answer shape.
#[derive(Debug)]
pub struct RespondToRequestParams {
    /// The run.
    pub run_id: RunId,
    /// The request.
    pub request_id: String,
    /// The daemon's answer.
    pub response: ProviderRequestAnswer,
}

/// The daemon's answer to one request a driver raised: the person's answers to a question, one per
/// question in the request's own order, or the approval pipeline's answer to a permission ask. A
/// secret answer's value reaches only the driver.
#[derive(Debug)]
pub enum ProviderRequestAnswer {
    /// The answers to a question.
    Question {
        /// One answer per question, in the request's order.
        answers: Vec<QuestionAnswer>,
    },
    /// The answer to a permission ask.
    Permission(ProviderPermissionAnswer),
}

/// The provider version the spawned process printed, never read from a launcher link that may
/// name another build: the text always, and its canonical parse when it parses. Every version
/// runs; nothing refuses on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DriverCliVersionReport {
    /// The version as printed.
    pub raw_version: String,
    /// Its canonical parse, when it parses.
    pub parsed_version: Option<String>,
}

/// One spawned-build reading's two binding carriers, read together so a binding row never pairs
/// one install's version with another install's path: what the build reported, and where it ran.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnedVersionBindingCarriers {
    /// The version the spawned build reported in-band.
    pub cli_version: DriverCliVersionReport,
    /// The build's absolute, symlink-resolved path, the one that answered.
    pub resolved_executable_path: PathBuf,
}

/// How one flag's value was reached on a live reading: probed, or taken from the driver's own
/// table where no probe is admissible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityDetectionSource {
    /// From the driver's own table.
    Static,
    /// By a zero-turn probe whose negative control still refused.
    Probed,
}

/// The driver's capability reading: the flags, the tools as the provider declared them and the
/// version the provider printed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GetCapabilitiesResult {
    /// The flags and contract version.
    pub capabilities: DriverCapabilities,
    /// The tools as the provider declared them.
    pub tools: Vec<ProviderToolMetadata>,
    /// The printed provider version; it describes this reading, not a capability, so it is not
    /// part of the stored capability snapshot.
    pub cli_version: DriverCliVersionReport,
    /// How each flag was reached, for every flag on a live reading; `None` on a reading rebuilt
    /// from the stored cache, which keeps values and not provenance. Never sent to a client.
    pub detection_source: Option<BTreeMap<DriverCapabilityFlag, CapabilityDetectionSource>>,
    /// The output-speed levels of a driver whose provider lists none per model: present only
    /// when `outputSpeed` is on and the driver declares a fixed set. With neither this nor a
    /// per-model set, a person's request for a level refuses. It survives a cache rebuild.
    pub output_speed_levels: Option<Vec<ProviderToken>>,
}

/// Params of `compact_context` (gated on `contextCompaction`); addresses one binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactContextParams {
    /// The session.
    pub session_id: SessionId,
    /// The binding.
    pub binding_id: RuntimeBindingId,
}

/// Params of `list_provider_commands` (gated on `providerCommands`); addresses one binding, with
/// the driver and account the daemon resolved it to and its one live run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListProviderCommandsParams {
    /// The session.
    pub session_id: SessionId,
    /// The binding.
    pub binding_id: RuntimeBindingId,
    /// The driver and account the binding runs on, which the group and each entry carry.
    pub binding: ProviderCommandBinding,
    /// The one live run on the binding; `None` when several are live.
    pub run_id: Option<RunId>,
}

/// Params of `list_models`: the session whose model control reads the catalog, and the account
/// to read it against, `None` for the provider's current account, which the driver resolves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListModelsParams {
    /// The session, only where this is the session's own provider; `None` for any other.
    pub session_id: Option<SessionId>,
    /// The account: the session's own bound account for its own provider; `None` for the
    /// provider's current account, refused as no account is registered or none is current.
    pub provider_account_id: Option<ProviderAccountId>,
}
