//! Which provider runs an agent: the binding a saved definition and a running agent share, a
//! definition's default and per-provider bindings, and the bindings as the list serves them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::methods::DRIVER_WIRE_TOKEN_MAX_LEN;
use crate::provider::name::ProviderName;
use crate::wire::Never;
use crate::wire::integer::SafeInt;
use crate::wire::list::unique_by;
use crate::wire::text::FreeFormText;

/// A provider's own vocabulary word: a model id, an effort or a speed, free-form and bounded,
/// because the vocabulary is the provider's.
pub type ProviderToken = FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>;

/// The schema of a provider token or `null`, for a binding member a macro declares.
pub(crate) type NullableProviderToken = crate::wire::NullableSchema<ProviderToken>;

/// Declares a struct holding a provider binding's members, the provider, the model, the effort,
/// the output speed and the larger window, with the struct's own members after the model.
macro_rules! provider_binding {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The provider.
            pub driver_name: $crate::provider::name::ProviderName,
            /// The model.
            pub model_id: $crate::agent::definition::binding::ProviderToken,
            $($own)*
            /// The effort, or `null` for the driver's default; checked when a run resolves.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::agent::definition::binding::NullableProviderToken")]
            pub effort: Option<$crate::agent::definition::binding::ProviderToken>,
            /// The output speed, where one was picked; a saved definition leaves it absent.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::agent::definition::binding::ProviderToken")]
            pub output_speed: Option<$crate::agent::definition::binding::ProviderToken>,
            /// The larger window chosen, in tokens, recorded when picked and sent on every resume
            /// and turn; absent is the model's default window.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::wire::integer::SafeInt<1>")]
            pub larger_window: Option<$crate::wire::integer::SafeInt<1>>,
        }
    };
}

pub(crate) use provider_binding;

provider_binding! {
    /// Which provider runs an agent, on which model, paying from which account, at which effort
    /// and speed: one shape for a saved definition's bindings and a running agent's binding.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct AgentProviderBinding {
        /// The account, or `null` to follow the provider's current account, resolved at run
        /// start; not a foreign key, so a removed account refuses resolution rather than
        /// rewriting this.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<ProviderAccountId>")]
        pub provider_account_id: Option<ProviderAccountId>,
    }
}

/// Refuses bindings that name one driver twice, so each provider resolves to exactly one
/// binding. A binding with no driver (a listed one naming a provider the app does not run) is
/// skipped.
fn binds_each_driver_once(
    drivers: impl IntoIterator<Item = Option<ProviderName>>,
) -> garde::Result {
    let drivers: Vec<ProviderName> = drivers.into_iter().flatten().collect();
    unique_by::<[ProviderName], _, _>(|driver: &ProviderName| *driver)(drivers.as_slice(), &())
}

/// A definition's bindings: the one used when a caller names no driver, and one per further
/// provider. The default is one the resolver may pick, never a fallback the others patch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|bindings: &Self, (): &()| binds_each_driver_once(
    std::iter::once(&bindings.default)
        .chain(&bindings.overrides)
        .map(|binding| Some(binding.driver_name)),
)))]
pub struct AgentDefinitionBindings {
    /// The default binding.
    pub default: AgentProviderBinding,
    /// One binding per further provider.
    pub overrides: Vec<AgentProviderBinding>,
}

/// A write's bindings: `overrides` may be left out, and is stored as an empty list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|bindings: &Self, (): &()| binds_each_driver_once(
    std::iter::once(&bindings.default)
        .chain(bindings.overrides.iter().flatten())
        .map(|binding| Some(binding.driver_name)),
)))]
pub struct AgentDefinitionBindingsDraft {
    /// The default binding.
    pub default: AgentProviderBinding,
    /// One binding per further provider.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Vec<AgentProviderBinding>")]
    pub overrides: Option<Vec<AgentProviderBinding>>,
}

/// Declares one arm of [`AgentListedProviderBinding`]: the provider member it names, then the
/// members every listed binding carries.
macro_rules! listed_binding_arm {
    ($(#[doc = $doc:literal])+ $name:ident { $($provider:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            $($provider)*
            /// The model.
            pub model_id: ProviderToken,
            /// The account, or `null` to follow the provider's current account.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<ProviderAccountId>")]
            pub provider_account_id: Option<ProviderAccountId>,
            /// The effort, or `null` for the driver's default.
            #[serde(deserialize_with = "crate::wire::nullable")]
            #[schemars(with = "crate::wire::NullableSchema<ProviderToken>")]
            pub effort: Option<ProviderToken>,
            /// The speed; a saved definition leaves it absent.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ProviderToken")]
            pub output_speed: Option<ProviderToken>,
            /// The larger window chosen, in tokens.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SafeInt<1>")]
            pub larger_window: Option<SafeInt<1>>,
        }
    };
}

listed_binding_arm! {
    /// A listed binding naming a provider this app runs.
    SupportedListedBinding {
        /// The provider.
        pub driver_name: ProviderName,
        /// Only a provider the app does not run is named as the file gave it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub unsupported_provider_name: Option<Never>,
    }
}

listed_binding_arm! {
    /// A listed binding naming a provider this app does not run.
    UnsupportedListedBinding {
        /// A provider this app runs is named by `driverName`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub driver_name: Option<Never>,
        /// The provider name the file gave.
        pub unsupported_provider_name: ProviderToken,
    }
}

/// A binding as the list serves it: `driverName` where the file names a provider this app runs,
/// or `unsupportedProviderName`, the name the file gave, where it does not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AgentListedProviderBinding {
    /// A provider this app runs.
    Supported(SupportedListedBinding),
    /// A provider this app does not run.
    Unsupported(UnsupportedListedBinding),
}

impl AgentListedProviderBinding {
    /// The provider, when this app runs it.
    pub fn driver_name(&self) -> Option<ProviderName> {
        match self {
            Self::Supported(binding) => Some(binding.driver_name),
            Self::Unsupported(_) => None,
        }
    }
}

/// A definition's bindings as the list serves them, each provider bound once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|bindings: &Self, (): &()| binds_each_driver_once(
    std::iter::once(&bindings.default)
        .chain(&bindings.overrides)
        .map(AgentListedProviderBinding::driver_name),
)))]
pub struct AgentListedBindings {
    /// The default binding.
    pub default: AgentListedProviderBinding,
    /// One binding per further provider.
    pub overrides: Vec<AgentListedProviderBinding>,
}
