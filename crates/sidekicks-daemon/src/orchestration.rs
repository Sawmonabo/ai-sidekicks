//! Orchestration: the helpers a provider's own agents may start inside a session, and the policy
//! every spawn carries, assembled from the person's own `Helpers at once` for that provider.
#![expect(
    dead_code,
    reason = "every spawn's helper policy is assembled here once the agent tree supplies it"
)]

use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::session_control::{SubagentDefinition, SubagentPolicy};

/// What a session's helper policy is assembled from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NativeSubagentPolicyInput {
    /// The person's `Helpers at once` for this provider: `None` for no limit, `0` for none.
    pub(crate) helpers_at_once: Option<SafeInt<0>>,
    /// The helpers the session's agents may start, each mapped by the driver to its own form.
    pub(crate) definitions: Vec<SubagentDefinition>,
}

/// The policy a spawn carries. `0` disables helpers, so the driver withholds the provider's helper
/// tool; no limit is carried as `None`, so the driver lifts the provider's own.
pub(crate) fn assemble_subagent_policy(input: NativeSubagentPolicyInput) -> SubagentPolicy {
    let helpers_at_once = match input.helpers_at_once {
        Some(count) if count.get() == 0 => return SubagentPolicy::Disabled {},
        Some(count) => Some(
            SafeInt::<1>::new(count.get()).expect("a safe count other than zero is at least one"),
        ),
        None => None,
    };
    SubagentPolicy::Enabled {
        helpers_at_once,
        definitions: input.definitions,
    }
}
