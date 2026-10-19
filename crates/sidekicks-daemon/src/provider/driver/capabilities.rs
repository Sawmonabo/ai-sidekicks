//! The capability flags a driver declares: the daemon's own gate on capability-bound calls, which
//! no client reads. The daemon stores one row per flag, in this order, through its writer, so a
//! cold start answers without asking the driver.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;
use strum::{IntoStaticStr, VariantArray};

pub(crate) mod writer;

/// One driver capability flag. The stored list and every map over the flags follow this order.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub(crate) enum DriverCapabilityFlag {
    /// Resumes a provider session.
    Resume,
    /// Steers a running turn.
    Steer,
    /// Asks the person mid-turn.
    InteractiveRequests,
    /// Runs tool servers.
    Mcp,
    /// Calls tools.
    ToolCalls,
    /// Streams its reasoning.
    ReasoningStream,
    /// Changes the model mid-session.
    ModelMutation,
    /// Answers in a given shape.
    StructuredOutput,
    /// Rolls a conversation back.
    Rollback,
    /// Moves the session onto a new provider conversation forked from the bound one at a message;
    /// never an undo.
    SessionFork,
    /// Keeps a session goal.
    SessionGoals,
    /// Calls the daemon's callback tools.
    CallbackTools,
    /// Runs subagents.
    Subagents,
    /// Compacts the bound session's provider-side context when the person asks.
    ContextCompaction,
    /// Lists the provider's commands and skills live.
    ProviderCommands,
    /// A faster-output mode the person sets and the provider declares a state for.
    OutputSpeed,
}

/// Each capability flag's value: every flag present, no other member.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub(crate) struct DriverCapabilityFlags(BTreeMap<DriverCapabilityFlag, bool>);

impl DriverCapabilityFlags {
    /// Every flag's value, asked of `value_of` once per flag, so no flag can be left out.
    pub(crate) fn from_fn(value_of: impl Fn(DriverCapabilityFlag) -> bool) -> Self {
        Self(
            DriverCapabilityFlag::VARIANTS
                .iter()
                .map(|flag| (*flag, value_of(*flag)))
                .collect(),
        )
    }

    /// Whether the driver declares `flag`. Every flag is held: the constructor asks for each one
    /// and deserializing refuses a map that misses one.
    pub(crate) fn is_on(&self, flag: DriverCapabilityFlag) -> bool {
        self.0[&flag]
    }
}

impl<'de> Deserialize<'de> for DriverCapabilityFlags {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let flags = BTreeMap::<DriverCapabilityFlag, bool>::deserialize(deserializer)?;
        match DriverCapabilityFlag::VARIANTS
            .iter()
            .find(|flag| !flags.contains_key(flag))
        {
            Some(missing) => Err(D::Error::custom(format!("the flag {missing:?} is missing"))),
            None => Ok(Self(flags)),
        }
    }
}

/// A driver's capability flags and contract version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DriverCapabilities {
    /// Each flag's value.
    pub(crate) flags: DriverCapabilityFlags,
    /// The driver's contract version.
    pub(crate) contract_version: FreeFormText<PROVIDER_WIRE_CONTRACT_VERSION_MAX_LEN>,
}
