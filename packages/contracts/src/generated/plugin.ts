// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Plugins: each provider's catalog, what one plugin carries, installing and removing it, the installed list, marketplaces, and a plugin's apps per provider account.

import type { ProviderAccountId } from "./provider/account/record.js";
import type { ProviderId } from "./provider/id.js";

/**
 * One plugin: its provider's id for it, its names, its description, the marketplace it comes
 * from, and where it is installed.
 */
export interface PluginSummary {
  /**
   * The provider's id for it.
   */
  id: string;
  /**
   * Its provider.
   */
  provider: ProviderId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The name a person reads.
   */
  displayName: string;
  /**
   * Its one-line description.
   */
  description: string;
  /**
   * The marketplace it comes from.
   */
  marketplace: string;
  /**
   * Whether it is installed in the daemon's plugin home.
   */
  installed: boolean;
  /**
   * Whether it is installed in the person's own terminal, independent of `installed`.
   */
  installedInTerminal: boolean;
}
/**
 * How many of each kind of item a plugin carries.
 */
export interface PluginCarriedCounts {
  /**
   * Agents.
   */
  agents: number;
  /**
   * Skills.
   */
  skills: number;
  /**
   * MCP servers.
   */
  mcpServers: number;
  /**
   * Hooks.
   */
  hooks: number;
}
/**
 * One catalog row: the plugin, and what it carries.
 */
export interface PluginCatalogEntry {
  /**
   * The provider's id for it.
   */
  id: string;
  /**
   * Its provider.
   */
  provider: ProviderId;
  /**
   * Its name.
   */
  name: string;
  /**
   * The name a person reads.
   */
  displayName: string;
  /**
   * Its one-line description.
   */
  description: string;
  /**
   * The marketplace it comes from.
   */
  marketplace: string;
  /**
   * Whether it is installed in the daemon's plugin home.
   */
  installed: boolean;
  /**
   * Whether it is installed in the person's own terminal, independent of `installed`.
   */
  installedInTerminal: boolean;
  /**
   * What it carries.
   */
  carries: PluginCarriedCounts;
}
/**
 * `plugin.catalog.list`: one provider's catalog, filtered by `query` as the person types. The
 * daemon filters, so a provider's own command needs no query. The catalog is read once per
 * opening of the view and held only while it is open.
 */
export interface PluginCatalogListRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The typed filter.
   */
  query?: string;
  /**
   * Where the page starts.
   */
  cursor?: string;
}
/**
 * A page of the catalog; `nextCursor` is present while more remain.
 */
export interface PluginCatalogListResponse {
  /**
   * The page.
   */
  plugins: PluginCatalogEntry[];
  /**
   * Where the next page starts.
   */
  nextCursor?: string;
}
/**
 * One plugin, named by its provider and that provider's id for it: what `plugin.read` and
 * `plugin.uninstall` act on.
 */
export interface PluginRef {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's id for it.
   */
  id: string;
}
/**
 * `plugin.install`: the plugin to install into the daemon's plugin home, and the option values
 * saved before it reaches any session.
 */
export interface PluginInstallRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The provider's id for it.
   */
  id: string;
  /**
   * Its option values.
   */
  options?: {
    [k: string]: string | undefined;
  };
}
/**
 * One item a plugin carries. A hook is named by its event, which the view puts in plain words;
 * `description` is `null` where the item has none.
 */
export interface PluginItem {
  /**
   * Its name.
   */
  name: string;
  /**
   * Its description, or `null`.
   */
  description: string | null;
}
/**
 * Every item a plugin carries, by kind.
 */
export interface PluginCarriedItems {
  /**
   * Agents.
   */
  agents: PluginItem[];
  /**
   * Skills.
   */
  skills: PluginItem[];
  /**
   * MCP servers.
   */
  mcpServers: PluginItem[];
  /**
   * Hooks.
   */
  hooks: PluginItem[];
}
/**
 * Where a plugin comes from: its marketplace, and for a plugin fetched from elsewhere, the
 * repository and the commit it was fetched at, always together.
 */
export interface PluginSource {
  /**
   * Its marketplace.
   */
  marketplace: string;
  /**
   * The repository it was fetched from.
   */
  repository?: string;
  /**
   * The commit it was fetched at.
   */
  commit?: string;
}
/**
 * What one plugin carries, each item by name and description, and its source.
 */
export interface PluginReadResponse {
  /**
   * What it carries.
   */
  items: PluginCarriedItems;
  /**
   * Where it comes from.
   */
  source: PluginSource;
}
/**
 * The installed plugin. The same method serves a plugin installed in the person's own terminal:
 * it installs that plugin, from the same marketplace, into the daemon's plugin home. An install
 * reaches a live session the way a saved agent does.
 */
export interface PluginInstallResponse {
  /**
   * The plugin.
   */
  plugin: PluginSummary;
}
/**
 * A removal's answer.
 */
export interface PluginUninstallResponse {
  /**
   * Always true.
   */
  uninstalled: true;
}
/**
 * `plugin.installed.list`: the installed plugins of one provider, or of every provider when
 * `provider` is absent.
 */
export interface PluginInstalledListRequest {
  /**
   * The provider.
   */
  provider?: ProviderId;
}
/**
 * The plugins installed in the daemon's plugin homes, and those installed in the person's own
 * terminal, each saying which.
 */
export interface PluginInstalledListResponse {
  /**
   * The plugins.
   */
  plugins: PluginSummary[];
}
/**
 * `plugin.marketplace.add`: adds a marketplace by a repository address or a folder, through the
 * provider's own command. A folder is picked with the platform's own chooser; the desktop main
 * process puts its path in place of the chooser's token. Each provider's official marketplace is
 * there without adding it.
 */
export interface PluginMarketplaceAddRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The repository address or folder.
   */
  source: string;
}
/**
 * The name the provider gave the added marketplace.
 */
export interface PluginMarketplaceAddResponse {
  /**
   * The marketplace's name.
   */
  name: string;
}
/**
 * `plugin.marketplace.remove`: removes a marketplace by the name its provider gave it.
 */
export interface PluginMarketplaceRemoveRequest {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The marketplace's name.
   */
  name: string;
}
/**
 * A marketplace removal's answer.
 */
export interface PluginMarketplaceRemoveResponse {
  /**
   * Always true.
   */
  removed: true;
}
/**
 * `plugin.app.list`: a plugin's apps, on a provider whose plugins carry them. An app is a tool
 * server its provider hosts, reached through a provider account's sign-in, so its link is kept
 * per account and every linked app reaches every session on that account without loading
 * anything.
 */
export interface PluginAppListRequest {
  /**
   * The provider, one whose plugins carry apps.
   */
  provider: ProviderId;
  /**
   * The plugin.
   */
  pluginId: string;
}
/**
 * One provider account's link to an app. `connectUrl` is the app's page on the provider's site,
 * where the person links it while signed in as that account; the view opens it in the browser and
 * reads the list again when the window regains focus. An account signed in with an API key
 * answers no apps, so it has no line.
 */
export interface PluginAppAccountLink {
  /**
   * The account.
   */
  providerAccountId: ProviderAccountId;
  /**
   * Whether the app is linked on it.
   */
  linked: boolean;
  /**
   * The app's page on the provider's site.
   */
  connectUrl: string;
}
/**
 * One app a plugin carries, and its link on each account of its provider.
 */
export interface PluginApp {
  /**
   * The app.
   */
  appId: string;
  /**
   * Its name.
   */
  name: string;
  /**
   * Its link on each account.
   */
  accounts: PluginAppAccountLink[];
}
/**
 * The plugin's apps.
 */
export interface PluginAppListResponse {
  /**
   * The apps.
   */
  apps: PluginApp[];
}

/** The methods of {@link PLUGIN_METHOD_DESCRIPTORS}, each with its kind. */
export interface PluginMethodDescriptors {
  readonly "plugin.catalog.list": {
    readonly method: "plugin.catalog.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "plugin.read": {
    readonly method: "plugin.read";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "plugin.install": {
    readonly method: "plugin.install";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "plugin.uninstall": {
    readonly method: "plugin.uninstall";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "plugin.installed.list": {
    readonly method: "plugin.installed.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "plugin.marketplace.add": {
    readonly method: "plugin.marketplace.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "plugin.marketplace.remove": {
    readonly method: "plugin.marketplace.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "plugin.app.list": {
    readonly method: "plugin.app.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link PLUGIN_METHOD_DESCRIPTORS}. */
export interface PluginMethodTypes {
  readonly "plugin.catalog.list": {
    readonly params: PluginCatalogListRequest;
    readonly result: PluginCatalogListResponse;
  };
  readonly "plugin.read": { readonly params: PluginRef; readonly result: PluginReadResponse };
  readonly "plugin.install": {
    readonly params: PluginInstallRequest;
    readonly result: PluginInstallResponse;
  };
  readonly "plugin.uninstall": {
    readonly params: PluginRef;
    readonly result: PluginUninstallResponse;
  };
  readonly "plugin.installed.list": {
    readonly params: PluginInstalledListRequest;
    readonly result: PluginInstalledListResponse;
  };
  readonly "plugin.marketplace.add": {
    readonly params: PluginMarketplaceAddRequest;
    readonly result: PluginMarketplaceAddResponse;
  };
  readonly "plugin.marketplace.remove": {
    readonly params: PluginMarketplaceRemoveRequest;
    readonly result: PluginMarketplaceRemoveResponse;
  };
  readonly "plugin.app.list": {
    readonly params: PluginAppListRequest;
    readonly result: PluginAppListResponse;
  };
}
/** The `plugin.*` methods. */
export const PLUGIN_METHOD_DESCRIPTORS: PluginMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "plugin.catalog.list": /* @__PURE__ */ Object.freeze({
    method: "plugin.catalog.list",
    procedureType: "query",
    mutating: false,
  }),
  "plugin.read": /* @__PURE__ */ Object.freeze({
    method: "plugin.read",
    procedureType: "query",
    mutating: false,
  }),
  "plugin.install": /* @__PURE__ */ Object.freeze({
    method: "plugin.install",
    procedureType: "mutation",
    mutating: true,
  }),
  "plugin.uninstall": /* @__PURE__ */ Object.freeze({
    method: "plugin.uninstall",
    procedureType: "mutation",
    mutating: true,
  }),
  "plugin.installed.list": /* @__PURE__ */ Object.freeze({
    method: "plugin.installed.list",
    procedureType: "query",
    mutating: false,
  }),
  "plugin.marketplace.add": /* @__PURE__ */ Object.freeze({
    method: "plugin.marketplace.add",
    procedureType: "mutation",
    mutating: true,
  }),
  "plugin.marketplace.remove": /* @__PURE__ */ Object.freeze({
    method: "plugin.marketplace.remove",
    procedureType: "mutation",
    mutating: true,
  }),
  "plugin.app.list": /* @__PURE__ */ Object.freeze({
    method: "plugin.app.list",
    procedureType: "query",
    mutating: false,
  }),
});
