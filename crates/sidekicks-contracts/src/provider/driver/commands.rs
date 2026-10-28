//! The provider commands a client reads: each command, skill or tool server prompt the provider
//! listed, grouped by the binding it was read under.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::length_limits::{
    PROVIDER_COMMAND_DESCRIPTION_MAX_LEN, PROVIDER_COMMAND_NAME_MAX_LEN,
    PROVIDER_DECLARED_TOKEN_MAX_LEN, PROVIDER_MCP_SERVER_NAME_MAX_LEN,
};
use crate::provider::id::ProviderId;
use crate::run::id::RunId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::list::BoundedVec;
use crate::wire::text::{ComposedText, FreeFormText};

/// The binding a command list was read under: the routing pair a group and each of its entries
/// carry. `providerAccountId` is `null` when the session bound no account, and `null` matches
/// nothing: an account-less list can be read but never routes a dispatch onto another binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCommandBinding {
    /// The provider.
    pub provider_name: ProviderId,
    /// The account the session bound, or `null` for none.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<ProviderAccountId>")]
    pub provider_account_id: Option<ProviderAccountId>,
}

/// Declares [`ProviderCommandEntry`]: per kind, the members every entry carries, then the kind's
/// own server and title members.
macro_rules! provider_command_entry {
    ($( $(#[doc = $doc:literal])+ $kind:ident { $($own:tt)* } )+) => {
        /// One command, skill or tool server prompt as the provider listed it, told apart by
        /// `kind`: a disabled entry is returned, not dropped, and `binding` is its routing key.
        /// `server` is present exactly on a prompt, and `title` only there.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        pub enum ProviderCommandEntry {$(
            $(#[doc = $doc])+
            $kind {
                /// The word the person types.
                name: FreeFormText<PROVIDER_COMMAND_NAME_MAX_LEN>,
                /// What it does, absent when the provider publishes none.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>")]
                description: Option<FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>>,
                /// The provider's hint for what follows the word, where it publishes one.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>")]
                argument_hint: Option<FreeFormText<PROVIDER_COMMAND_DESCRIPTION_MAX_LEN>>,
                /// The scope the provider declares, where it declares one.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>")]
                scope: Option<FreeFormText<PROVIDER_DECLARED_TOKEN_MAX_LEN>>,
                /// Whether it is enabled, where the provider draws that distinction.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "bool")]
                enabled: Option<bool>,
                /// The binding the entry was read under.
                binding: ProviderCommandBinding,
                $($own)*
            },
        )+}
    };
}

provider_command_entry! {
    /// A provider's command.
    Command {
        /// Only a prompt names a server.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        server: Option<Never>,
        /// Only a prompt carries a title.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        title: Option<Never>,
    }
    /// A skill.
    Skill {
        /// Only a prompt names a server.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        server: Option<Never>,
        /// Only a prompt carries a title.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        title: Option<Never>,
    }
    /// A working tool server's prompt, grouped under the server that publishes it.
    Prompt {
        /// The tool server that publishes the prompt.
        server: FreeFormText<PROVIDER_MCP_SERVER_NAME_MAX_LEN>,
        /// The prompt's title for people, where the server gives one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ComposedText")]
        title: Option<ComposedText>,
    }
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

/// The reply of `provider.command.list`: one group per live binding, so each entry keeps
/// where it came from, and at least one, since an agent with no live binding is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ProviderCommandListResponse {
    /// The groups.
    pub bindings: BoundedVec<ProviderCommandBindingGroup, 1, { usize::MAX }>,
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
        Definition::read::<ProviderCommandListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
