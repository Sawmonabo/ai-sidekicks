//! Installing and updating a provider's command in one place. Each runs the provider's own
//! installer or updater as the person, keyed by provider and place; its stream sends the last
//! outcome first.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::id::ProviderId;
use crate::provider::settings::{ProviderPlaceRequest, ProviderVersion};
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest install failure reason: the installer's last lines, credentials removed.
    pub const PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN: usize = 4096;
    /// The longest installer command a failed install shows.
    pub const PROVIDER_INSTALL_COMMAND_MAX_LEN: usize = 1024;
}

/// Where one provider's install in one place has got to. The install runs the provider's own
/// installer as the person, keyed by provider and place, and the stream's first message is the
/// last outcome in that place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum ProviderInstallProgress {
    /// The installer runs.
    Running {
        /// The provider.
        provider: ProviderId,
    },
    /// The installer finished.
    Installed {
        /// The provider.
        provider: ProviderId,
    },
    /// The installer failed.
    Failed {
        /// The provider.
        provider: ProviderId,
        /// The installer's last lines, credentials removed.
        reason: FreeFormText<PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN>,
        /// The installer command, for the person to run.
        command: FreeFormText<PROVIDER_INSTALL_COMMAND_MAX_LEN>,
    },
}

/// Where one provider's update in one place has got to: `Update` on its row, or the service's own
/// run when the latest-version marker names a build the command does not resolve to. The outcome
/// is read from the version the command resolves to afterwards, and the stream's first message is
/// the last outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum ProviderInstallUpdateProgress {
    /// The update runs.
    Running {
        /// The provider.
        provider: ProviderId,
    },
    /// The command resolves to a newer build.
    Updated {
        /// The provider.
        provider: ProviderId,
        /// The version it left.
        from_version: ProviderVersion,
        /// The version it resolves to.
        to_version: ProviderVersion,
    },
    /// The command already resolves to the latest build.
    Current {
        /// The provider.
        provider: ProviderId,
        /// The version it resolves to.
        version: ProviderVersion,
    },
    /// The update ran and the command resolves to the same build.
    NotUpdated {
        /// The provider.
        provider: ProviderId,
        /// The version it still resolves to.
        version: ProviderVersion,
        /// The update's last lines, credentials removed.
        reason: FreeFormText<PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN>,
        /// The update command, for the person to run.
        command: FreeFormText<PROVIDER_INSTALL_COMMAND_MAX_LEN>,
    },
    /// The install sits where only an administrator can write, so the person runs the command.
    NeedsAdministrator {
        /// The provider.
        provider: ProviderId,
        /// The update command, for the person to run.
        command: FreeFormText<PROVIDER_INSTALL_COMMAND_MAX_LEN>,
    },
}

methods! {
    /// Every `provider.install.start*` method: its name, how it answers, and its shapes.
    pub const PROVIDER_INSTALL_METHOD_DESCRIPTORS = [
        /// Starts a provider's installer.
        ProviderInstall = mutation "provider.install.start" {
            mutating: true,
            params: ProviderPlaceRequest,
            result: EmptyPayload,
            refusals: [
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
                ProviderNoBuildForSystem,
            ],
        },
        /// Streams a provider's install, its last outcome first.
        ProviderInstallSubscribe = subscription "provider.install.subscribe" {
            mutating: false,
            params: ProviderPlaceRequest,
            result: SubscribeAckResponse,
            emission: ProviderInstallProgress,
            refusals: [
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
            ],
        },
        /// Stops a provider's installer and everything it started.
        ProviderInstallStop = mutation "provider.install.stop" {
            mutating: true,
            params: ProviderPlaceRequest,
            result: EmptyPayload,
            refusals: [
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
            ],
        },
        /// Updates a provider's command in one place.
        ProviderInstallUpdate = mutation "provider.installUpdate.start" {
            mutating: true,
            params: ProviderPlaceRequest,
            result: EmptyPayload,
            refusals: [
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
                ProviderNoBuildForSystem,
            ],
        },
        /// Streams a provider's update in one place, its last outcome first.
        ProviderInstallUpdateSubscribe = subscription "provider.installUpdate.subscribe" {
            mutating: false,
            params: ProviderPlaceRequest,
            result: SubscribeAckResponse,
            emission: ProviderInstallUpdateProgress,
            refusals: [
                ProviderDistributionNotFound,
                ProviderDistributionNeedsWsl2,
            ],
        },
    ];
}

/// The TypeScript module of a provider's install and update.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/install",
    doc: "The `provider.install.start*` methods: installing and updating a provider's command in one \
          place.",
    definitions: &[
        Definition::read::<ProviderInstallProgress>(),
        Definition::read::<ProviderInstallUpdateProgress>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&PROVIDER_INSTALL_METHOD_DESCRIPTORS],
};
