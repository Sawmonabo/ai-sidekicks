//! The provider commands a client reads: each command, skill or tool server prompt the provider
//! listed, grouped by the binding it was read under.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::driver::length_limits::{
    DRIVER_MCP_SERVER_NAME_MAX_LEN, DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN,
    DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN, DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN,
};
use crate::provider::name::ProviderName;
use crate::run::id::RunId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::bounded_text::BoundedText;
use crate::wire::text::FreeFormText;

/// The binding a command list was read under: the routing pair a group and each of its entries
/// carry. `providerAccountId` is `null` when the session bound no account, and `null` matches
/// nothing: an account-less list can be read but never routes a dispatch onto another binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCommandBinding {
    /// The provider.
    pub driver_name: ProviderName,
    /// The account the session bound, or `null` for none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<BoundedText<1, { usize::MAX }>>")]
    pub provider_account_id: Option<BoundedText<1, { usize::MAX }>>,
}

/// The kind of a command entry that is not a tool server's prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum ProviderCommandKind {
    /// A provider's command.
    Command,
    /// A skill.
    Skill,
}

/// The kind of a tool server's prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(inline)]
pub enum ProviderPromptKind {
    /// A working tool server's prompt.
    Prompt,
}

/// Declares one arm of [`ProviderCommandEntry`]: the members every entry carries, then the arm's
/// own kind and server.
macro_rules! provider_command_entry_arm {
    ($(#[doc = $doc:literal])+ $name:ident { $($arm:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The word the person types.
            pub name: FreeFormText<DRIVER_PROVIDER_COMMAND_NAME_MAX_LEN>,
            /// What it does, absent when the provider publishes none.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>")]
            pub description: Option<FreeFormText<DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>>,
            /// The provider's hint for what follows the word, where it publishes one.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>")]
            pub argument_hint: Option<FreeFormText<DRIVER_PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>>,
            /// The scope the provider declares, where it declares one.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN>")]
            pub scope: Option<FreeFormText<DRIVER_PROVIDER_DECLARED_TOKEN_MAX_LEN>>,
            /// Whether it is enabled, where the provider draws that distinction.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "bool")]
            pub enabled: Option<bool>,
            /// The binding the entry was read under.
            pub binding: ProviderCommandBinding,
            $($arm)*
        }
    };
}

provider_command_entry_arm! {
    /// A tool server's prompt, grouped under the server that publishes it.
    ProviderPromptEntry {
        /// Always `prompt`.
        pub kind: ProviderPromptKind,
        /// The tool server that publishes the prompt.
        pub server: FreeFormText<DRIVER_MCP_SERVER_NAME_MAX_LEN>,
    }
}

provider_command_entry_arm! {
    /// A provider's command or a skill.
    ProviderCommandOrSkillEntry {
        /// A command or a skill.
        pub kind: ProviderCommandKind,
        /// Only a prompt names a server.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub server: Option<Never>,
    }
}

/// One command, skill or tool server prompt as the provider listed it: a disabled entry is
/// returned, not dropped, and `binding` is its routing key. `server` is present exactly on a
/// prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderCommandEntry {
    /// A tool server's prompt.
    Prompt(ProviderPromptEntry),
    /// A provider's command or a skill.
    CommandOrSkill(ProviderCommandOrSkillEntry),
}

/// One live binding's command list, whole as the provider published it, with where it came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCommandBindingGroup {
    /// The one live run on the binding; `null` when none or several are live.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<RunId>")]
    pub run_id: Option<RunId>,
    /// The binding.
    pub binding: ProviderCommandBinding,
    /// Its entries.
    pub entries: Vec<ProviderCommandEntry>,
}

/// The reply of `driver.listProviderCommands`: one group per live binding, so each entry keeps
/// where it came from, and at least one, since an agent with no live binding is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCommandListResult {
    /// The groups.
    #[garde(length(min = 1))]
    #[schemars(length(min = 1))]
    pub bindings: Vec<ProviderCommandBindingGroup>,
}

/// The TypeScript module of provider commands.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/commands",
    doc: "The provider commands a client reads: each command, skill or tool server prompt the \
          provider listed, grouped by the binding it was read under.",
    definitions: &[
        Definition::read::<ProviderCommandBinding>(),
        Definition::read::<ProviderCommandEntry>().checked(),
        Definition::read::<ProviderCommandBindingGroup>(),
        Definition::read::<ProviderCommandListResult>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
