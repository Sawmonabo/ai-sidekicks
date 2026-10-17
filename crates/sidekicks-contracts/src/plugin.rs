//! Plugins: the Browse plugins view's wire. Each provider's plugin catalog, what one plugin
//! carries, installing and removing it, the installed list, the marketplaces a person adds, and the
//! apps a plugin carries, per provider account.
//!
//! The daemon answers every method through the provider's own plugin commands, run against a
//! plugin home the daemon owns, one per provider: never an account home and never the person's own
//! home. A plugin installed in the person's own terminal is read without writing and listed as
//! installed there; installing it here installs the same plugin into the daemon's plugin home.
//! Catalogs shared between people are never listed, because the product has one person. An
//! installed plugin's agents and skills reach the saved-agent and skill lists as their read-only
//! plugin origin; those lists carry them, not this module.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::method::methods;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::methods::DRIVER_WIRE_TOKEN_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::web_address::HttpsAddress;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, FreeFormText, NonEmptyText};
use crate::wire::{NullableSchema, True, nullable};

/// A token in a provider's own plugin vocabulary: a plugin id, a name, a marketplace.
pub type PluginToken = FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>;

/// Declares a plugin as a list serves it, with the members every such list repeats.
macro_rules! plugin_summary {
    ($(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            /// The provider's id for it.
            pub id: PluginToken,
            /// Its provider.
            pub provider: ProviderId,
            /// Its name.
            pub name: PluginToken,
            /// The name a person reads.
            pub display_name: NonEmptyText,
            /// Its one-line description.
            pub description: String,
            /// The marketplace it comes from.
            pub marketplace: PluginToken,
            /// Whether it is installed in the daemon's plugin home.
            pub installed: bool,
            /// Whether it is installed in the person's own terminal, independent of `installed`.
            pub installed_in_terminal: bool,
            $($extra)*
        }
    };
}

plugin_summary! {
    /// One plugin: its provider's id for it, its names, its description, the marketplace it comes
    /// from, and where it is installed.
    PluginSummary {}
}

/// How many of each kind of item a plugin carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCarriedCounts {
    /// Agents.
    pub agents: SafeInt<0>,
    /// Skills.
    pub skills: SafeInt<0>,
    /// MCP servers.
    pub mcp_servers: SafeInt<0>,
    /// Hooks.
    pub hooks: SafeInt<0>,
}

plugin_summary! {
    /// One catalog row: the plugin, and what it carries.
    PluginCatalogEntry {
        /// What it carries.
        pub carries: PluginCarriedCounts,
    }
}

/// `plugin.catalog.list`: one provider's catalog, filtered by `query` as the person types. The
/// daemon filters, so a provider's own command needs no query. The catalog is read once per
/// opening of the view and held only while it is open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginCatalogListRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The typed filter.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedText<0, DRIVER_WIRE_TOKEN_MAX_LEN>")]
    pub query: Option<BoundedText<0, DRIVER_WIRE_TOKEN_MAX_LEN>>,
    /// Where the page starts.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PluginToken")]
    pub cursor: Option<PluginToken>,
}

/// A page of the catalog; `nextCursor` is present while more remain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginCatalogListResponse {
    /// The page.
    pub plugins: Vec<PluginCatalogEntry>,
    /// Where the next page starts.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PluginToken")]
    pub next_cursor: Option<PluginToken>,
}

/// One plugin, named by its provider and that provider's id for it: what `plugin.read`,
/// `plugin.install` and `plugin.uninstall` act on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginRef {
    /// The provider.
    pub provider: ProviderId,
    /// The provider's id for it.
    pub id: PluginToken,
}

/// One item a plugin carries. A hook is named by its event, which the view puts in plain words;
/// `description` is `null` where the item has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginItem {
    /// Its name.
    pub name: NonEmptyText,
    /// Its description, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<String>")]
    pub description: Option<String>,
}

/// Every item a plugin carries, by kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCarriedItems {
    /// Agents.
    pub agents: Vec<PluginItem>,
    /// Skills.
    pub skills: Vec<PluginItem>,
    /// MCP servers.
    pub mcp_servers: Vec<PluginItem>,
    /// Hooks.
    pub hooks: Vec<PluginItem>,
}

/// Where a plugin comes from: its marketplace, and for a plugin fetched from elsewhere, the
/// repository and the commit it was fetched at, always together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|source: &Self, (): &()| {
    if source.repository.is_some() == source.commit.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "a plugin fetched from a repository names the repository and its commit together",
        ))
    }
}))]
#[schemars(extend("dependentRequired" = { "repository": ["commit"], "commit": ["repository"] }))]
pub struct PluginSource {
    /// Its marketplace.
    pub marketplace: PluginToken,
    /// The repository it was fetched from.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<FILE_PATH_MAX_LEN>")]
    pub repository: Option<FreeFormText<FILE_PATH_MAX_LEN>>,
    /// The commit it was fetched at.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "PluginToken")]
    pub commit: Option<PluginToken>,
}

/// What one plugin carries, each item by name and description, and its source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginReadResponse {
    /// What it carries.
    #[garde(skip)]
    pub items: PluginCarriedItems,
    /// Where it comes from.
    #[garde(dive)]
    pub source: PluginSource,
}

/// The installed plugin. The same method serves a plugin installed in the person's own terminal:
/// it installs that plugin, from the same marketplace, into the daemon's plugin home. An install
/// reaches a live session the way a saved agent does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginInstallResponse {
    /// The plugin.
    pub plugin: PluginSummary,
}

/// A removal's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginUninstallResponse {
    /// Always true.
    pub uninstalled: True,
}

/// `plugin.installed.list`: the installed plugins of one provider, or of every provider when
/// `provider` is absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginInstalledListRequest {
    /// The provider.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderId")]
    pub provider: Option<ProviderId>,
}

/// The plugins installed in the daemon's plugin homes, and those installed in the person's own
/// terminal, each saying which.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginInstalledListResponse {
    /// The plugins.
    pub plugins: Vec<PluginSummary>,
}

/// `plugin.marketplace.add`: adds a marketplace by a repository address or a folder, through the
/// provider's own command. A folder is picked with the platform's own chooser; the desktop main
/// process puts its path in place of the chooser's token. Each provider's official marketplace is
/// there without adding it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginMarketplaceAddRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The repository address or folder.
    pub source: FreeFormText<FILE_PATH_MAX_LEN>,
}

/// The name the provider gave the added marketplace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginMarketplaceAddResponse {
    /// The marketplace's name.
    pub name: PluginToken,
}

/// `plugin.marketplace.remove`: removes a marketplace by the name its provider gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginMarketplaceRemoveRequest {
    /// The provider.
    pub provider: ProviderId,
    /// The marketplace's name.
    pub name: PluginToken,
}

/// A marketplace removal's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginMarketplaceRemoveResponse {
    /// Always true.
    pub removed: True,
}

/// `plugin.app.list`: a plugin's apps, on a provider whose plugins carry them. An app is a tool
/// server its provider hosts, reached through a provider account's sign-in, so its link is kept
/// per account and every linked app reaches every session on that account without loading
/// anything.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginAppListRequest {
    /// The provider, one whose plugins carry apps.
    pub provider: ProviderId,
    /// The plugin.
    pub plugin_id: PluginToken,
}

/// One provider account's link to an app. `connectUrl` is the app's page on the provider's site,
/// where the person links it while signed in as that account; the view opens it in the browser and
/// reads the list again when the window regains focus. An account signed in with an API key
/// answers no apps, so it has no line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginAppAccountLink {
    /// The account.
    pub provider_account_id: ProviderAccountId,
    /// Whether the app is linked on it.
    pub linked: bool,
    /// The app's page on the provider's site.
    pub connect_url: HttpsAddress<{ usize::MAX }>,
}

/// One app a plugin carries, and its link on each account of its provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginApp {
    /// The app.
    pub app_id: PluginToken,
    /// Its name.
    pub name: NonEmptyText,
    /// Its link on each account.
    pub accounts: Vec<PluginAppAccountLink>,
}

/// The plugin's apps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct PluginAppListResponse {
    /// The apps.
    pub apps: Vec<PluginApp>,
}

methods! {
    /// The `plugin.*` methods.
    pub const PLUGIN_METHOD_DESCRIPTORS = [
        /// One provider's catalog, filtered.
        PluginCatalogList = query "plugin.catalog.list" {
            mutating: false,
            params: PluginCatalogListRequest,
            result: PluginCatalogListResponse,
            refusals: [],
        },
        /// What one plugin carries.
        PluginRead = query "plugin.read" {
            mutating: false,
            params: PluginRef,
            result: PluginReadResponse,
            refusals: [],
        },
        /// Installs a plugin into the daemon's plugin home.
        PluginInstall = mutation "plugin.install" {
            mutating: true,
            params: PluginRef,
            result: PluginInstallResponse,
            refusals: [],
        },
        /// Removes a plugin.
        PluginUninstall = mutation "plugin.uninstall" {
            mutating: true,
            params: PluginRef,
            result: PluginUninstallResponse,
            refusals: [],
        },
        /// The installed plugins.
        PluginInstalledList = query "plugin.installed.list" {
            mutating: false,
            params: PluginInstalledListRequest,
            result: PluginInstalledListResponse,
            refusals: [],
        },
        /// Adds a marketplace.
        PluginMarketplaceAdd = mutation "plugin.marketplace.add" {
            mutating: true,
            params: PluginMarketplaceAddRequest,
            result: PluginMarketplaceAddResponse,
            refusals: [],
        },
        /// Removes a marketplace.
        PluginMarketplaceRemove = mutation "plugin.marketplace.remove" {
            mutating: true,
            params: PluginMarketplaceRemoveRequest,
            result: PluginMarketplaceRemoveResponse,
            refusals: [],
        },
        /// A plugin's apps.
        PluginAppList = query "plugin.app.list" {
            mutating: false,
            params: PluginAppListRequest,
            result: PluginAppListResponse,
            refusals: [DriverCapabilityUnsupported],
        },
    ];
}

/// The TypeScript module of the plugins view.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "plugin",
    doc: "Plugins: each provider's catalog, what one plugin carries, installing and removing it, \
          the installed list, marketplaces, and a plugin's apps per provider account.",
    definitions: &[
        Definition::read::<PluginSummary>().checked(),
        Definition::read::<PluginCarriedCounts>(),
        Definition::read::<PluginCatalogEntry>(),
        Definition::read::<PluginCatalogListRequest>(),
        Definition::read::<PluginCatalogListResponse>(),
        Definition::read::<PluginRef>().checked(),
        Definition::read::<PluginItem>(),
        Definition::read::<PluginCarriedItems>(),
        Definition::read::<PluginSource>().checked(),
        Definition::read::<PluginReadResponse>(),
        Definition::read::<PluginInstallResponse>(),
        Definition::read::<PluginUninstallResponse>(),
        Definition::read::<PluginInstalledListRequest>(),
        Definition::read::<PluginInstalledListResponse>(),
        Definition::read::<PluginMarketplaceAddRequest>(),
        Definition::read::<PluginMarketplaceAddResponse>(),
        Definition::read::<PluginMarketplaceRemoveRequest>(),
        Definition::read::<PluginMarketplaceRemoveResponse>(),
        Definition::read::<PluginAppListRequest>(),
        Definition::read::<PluginAppAccountLink>(),
        Definition::read::<PluginApp>(),
        Definition::read::<PluginAppListResponse>(),
    ],
    constants: &[],
    method_tables: &[&PLUGIN_METHOD_DESCRIPTORS],
};
