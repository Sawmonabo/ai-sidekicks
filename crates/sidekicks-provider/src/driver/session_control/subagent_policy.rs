//! The helper policy a session opens with, and the one mapping from the person's `Helpers at once`
//! onto it.

use serde::{Deserialize, Serialize};
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::wire::integer::SafeInt;

/// The provider-native subagent policy (gated on `subagents`). Provider subagents run inside the
/// session only, so their usage counts against the run and their tool calls go through the same
/// approval pipeline. A `Helpers at once` setting of 0 is `Disabled`, which withholds the
/// provider's helper tool; nothing bounds how deep helpers nest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "policy",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubagentPolicy {
    /// No helpers.
    Disabled {},
    /// Helpers run.
    Enabled {
        /// How many run at once, or `None` for no limit.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "sidekicks_contracts::wire::present"
        )]
        helpers_at_once: Option<SafeInt<1>>,
        /// The helpers the lead can hand work to.
        definitions: Vec<SubagentDefinition>,
    },
}

/// One helper as each driver maps it onto its provider's own form; the members past `name`,
/// `prompt` and `description` are mapped where the provider supports them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubagentDefinition {
    /// The helper's name.
    pub(crate) name: String,
    /// The helper's own instructions.
    pub(crate) prompt: String,
    /// When the lead should hand work to it.
    pub(crate) description: String,
    /// Its model.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) model: Option<ProviderToken>,
    /// The tools it may use.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) tools: Option<Vec<String>>,
    /// Its reasoning effort.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) effort: Option<ProviderToken>,
    /// How many turns it may take.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    pub(crate) max_turns: Option<SafeInt<1>>,
}

impl SubagentPolicy {
    /// The policy for the person's `Helpers at once`: `0` is `Disabled`, a count is that limit and
    /// unset is no limit, so helpers run unbounded rather than being switched off.
    pub fn from_helper_limit(
        helpers_at_once: Option<SafeInt<0>>,
        definitions: Vec<SubagentDefinition>,
    ) -> Self {
        let Some(count) = helpers_at_once else {
            return Self::Enabled {
                helpers_at_once: None,
                definitions,
            };
        };
        // Only zero falls below one, and zero switches helpers off.
        match SafeInt::<1>::new(count.get()) {
            Some(limit) => Self::Enabled {
                helpers_at_once: Some(limit),
                definitions,
            },
            None => Self::Disabled {},
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::SubagentPolicy;

    #[rstest]
    #[case::zero_switches_helpers_off(Some(0), SubagentPolicy::Disabled {})]
    #[case::unset_is_no_limit(
        None,
        SubagentPolicy::Enabled { helpers_at_once: None, definitions: Vec::new() }
    )]
    #[case::a_count_is_that_limit(
        Some(3),
        SubagentPolicy::Enabled { helpers_at_once: SafeInt::new(3), definitions: Vec::new() }
    )]
    fn from_helper_limit_maps_helpers_at_once(
        #[case] helpers_at_once: Option<u64>,
        #[case] expected: SubagentPolicy,
    ) {
        let helpers_at_once =
            helpers_at_once.map(|count| SafeInt::new(count).expect("a safe count"));
        assert_eq!(
            SubagentPolicy::from_helper_limit(helpers_at_once, Vec::new()),
            expected
        );
    }
}
