//! The definition verbs' refusals: an export that could not write, a definition that cannot
//! resolve to a runnable agent, and an update the daemon refused.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{AGENT_REASON_MAX_LEN, AgentDefinitionId};
use crate::wire::text::FreeFormText;

/// The operating system's own cause of a failed export write, as it reported it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentExportWriteFailedDetails {
    /// The cause.
    pub cause: FreeFormText<AGENT_REASON_MAX_LEN>,
}

/// Declares the details of a resolution refusal whose `definitionId` has the given type and
/// attributes: a definition's id where one always runs, nullable where the agent may run none.
/// Each reason names what was asked for beside what is available, since neither alone tells a
/// person what to edit.
macro_rules! agent_resolution_refused_details {
    (
        $(#[doc = $doc:literal])+
        $name:ident, $(#[$id_meta:meta])* $definition_id:ty
    ) => {
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            Eq,
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
            garde::Validate,
        )]
        #[serde(
            tag = "reason",
            rename_all = "snake_case",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        pub enum $name {
            /// The pinned model its provider no longer offers, or, with a `null` model, a driver
            /// the definition binds no model for.
            ModelUnavailable {
                /// The definition.
                $(#[$id_meta])*
                definition_id: $definition_id,
                /// The driver.
                driver_name: $crate::provider::name::ProviderName,
                /// The model, or `null` for none bound.
                #[serde(deserialize_with = "crate::wire::nullable")]
                #[schemars(with = "crate::wire::NullableSchema<crate::agent::definition::binding::ProviderToken>")]
                model_id: Option<$crate::agent::definition::binding::ProviderToken>,
            },
            /// The stored effort and the efforts the model publishes.
            EffortUnsupported {
                /// The definition.
                $(#[$id_meta])*
                definition_id: $definition_id,
                /// The stored effort.
                effort: $crate::agent::definition::binding::ProviderToken,
                /// The model's efforts.
                effort_levels: Vec<$crate::agent::definition::binding::ProviderToken>,
            },
            /// The pinned account this machine no longer holds.
            AccountUnavailable {
                /// The definition.
                $(#[$id_meta])*
                definition_id: $definition_id,
                /// The account.
                provider_account_id: $crate::provider::account::record::ProviderAccountId,
            },
            /// The allowlisted tools that have left the catalog, and the tools the driver has.
            AllowlistUnrealizable {
                /// The definition.
                $(#[$id_meta])*
                definition_id: $definition_id,
                /// The missing tools, at least one.
                #[garde(length(min = 1))]
                #[schemars(length(min = 1))]
                tool_names: Vec<$crate::agent::definition::ToolName>,
                /// The driver's tools.
                supported_tool_names: Vec<$crate::agent::definition::ToolName>,
            },
            /// The provider name the definition's file carries, which this app does not run.
            ProviderUnsupported {
                /// The definition.
                $(#[$id_meta])*
                definition_id: $definition_id,
                /// The name the file gave.
                unsupported_provider_name: $crate::agent::definition::binding::ProviderToken,
            },
        }
    };
}

#[expect(
    unused_imports,
    reason = "the workflow document's resolution refusal, whose definition may be null, declares \
              its details with it"
)]
pub(crate) use agent_resolution_refused_details;

agent_resolution_refused_details! {
    /// Why a definition that exists cannot produce a runnable agent now. The remedy is the same
    /// in every case, edit the definition or repair the account, so one code carries a reason.
    AgentResolutionRefusedDetails, AgentDefinitionId
}

/// Why an update was refused: the definition is a plugin's agent, which is read-only, or a
/// reattach named a record that is not orphaned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentUpdateRefusedReason {
    /// A plugin's agent.
    PluginReadOnly,
    /// The record is not orphaned.
    NotOrphaned,
}

/// The update refusal's details: the definition and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUpdateRefusedDetails {
    /// The definition.
    pub definition_id: AgentDefinitionId,
    /// Why.
    pub reason: AgentUpdateRefusedReason,
}
