// Plugins: the Browse plugins view's wire. Each provider's plugin catalog, what one plugin
// carries, installing and removing it, the installed list, the marketplaces a person adds, and a
// Codex plugin's apps per account.
//
// The daemon answers every verb through the provider's own plugin commands, run against a plugin
// home the daemon owns, one per provider: never an account home and never the person's own home.
// A plugin installed in the person's own terminal is read without writing and listed as installed
// there; installing it here installs the same plugin into the daemon's plugin home. Catalogs
// shared between people are never listed, because the product has one person.
//
// An installed plugin's agents and skills reach the saved-agent and skill lists as their
// read-only plugin origin; those lists carry them, not this file.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import {
  ProviderAccountIdSchema,
  ProviderNameSchema,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { DRIVER_WIRE_TOKEN_MAX_LEN } from "./provider-driver.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";

/** A token in a provider's own plugin vocabulary: a plugin id, a name, a marketplace. */
const pluginTokenSchema = (label: string): z.ZodString =>
  wireFreeFormString(DRIVER_WIRE_TOKEN_MAX_LEN, label);

// The plugin as a list serves it

/**
 * One plugin: its provider's id for it, its name and the name a person reads, its
 * one-line description, the marketplace it comes from, and where it is installed:
 * `installed` in the daemon's plugin home, `installedInTerminal` in the person's own
 * terminal. The two are independent.
 */
export interface PluginSummary {
  id: string;
  provider: ProviderName;
  name: string;
  displayName: string;
  description: string;
  marketplace: string;
  installed: boolean;
  installedInTerminal: boolean;
}

const pluginSummaryFields = {
  id: pluginTokenSchema("PluginSummary.id"),
  provider: ProviderNameSchema,
  name: pluginTokenSchema("PluginSummary.name"),
  displayName: z.string().min(1),
  description: z.string(),
  marketplace: pluginTokenSchema("PluginSummary.marketplace"),
  installed: z.boolean(),
  installedInTerminal: z.boolean(),
};

/** Parses a {@link PluginSummary}. */
export const PluginSummarySchema: z.ZodType<PluginSummary> = z.object(pluginSummaryFields).strict();

/** How many of each kind of item a plugin carries. */
export interface PluginCarriedCounts {
  agents: number;
  skills: number;
  mcpServers: number;
  hooks: number;
}
/** Parses {@link PluginCarriedCounts}. */
export const PluginCarriedCountsSchema: z.ZodType<PluginCarriedCounts> = z
  .object({
    agents: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    mcpServers: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
  })
  .strict();

/** One catalog row: the plugin, and what it carries. */
export interface PluginCatalogEntry extends PluginSummary {
  carries: PluginCarriedCounts;
}
/** Parses a {@link PluginCatalogEntry}. */
export const PluginCatalogEntrySchema: z.ZodType<PluginCatalogEntry> = z
  .object({ ...pluginSummaryFields, carries: PluginCarriedCountsSchema })
  .strict();

// plugin.catalogList

/**
 * One provider's catalog, filtered by `query` as the person types. Neither
 * provider's own verb takes a query, so the daemon filters. The catalog is read
 * once per opening of the view and held only while it is open.
 */
export interface PluginCatalogListRequest {
  provider: ProviderName;
  query?: string | undefined;
  cursor?: string | undefined;
}
/** Parses a {@link PluginCatalogListRequest}. */
export const PluginCatalogListRequestSchema: z.ZodType<
  PluginCatalogListRequest,
  PluginCatalogListRequest
> = z
  .object({
    provider: ProviderNameSchema,
    query: z.string().max(DRIVER_WIRE_TOKEN_MAX_LEN).optional(),
    cursor: pluginTokenSchema("PluginCatalogListRequest.cursor").optional(),
  })
  .strict();

/** A page of the catalog; `nextCursor` is present while more remain. */
export interface PluginCatalogListResponse {
  plugins: PluginCatalogEntry[];
  nextCursor?: string | undefined;
}
/** Parses a {@link PluginCatalogListResponse}. */
export const PluginCatalogListResponseSchema: z.ZodType<PluginCatalogListResponse> = z
  .object({
    plugins: z.array(PluginCatalogEntrySchema),
    nextCursor: pluginTokenSchema("PluginCatalogListResponse.nextCursor").optional(),
  })
  .strict();

// plugin.read

/** One plugin, named by its provider and that provider's id for it. */
export interface PluginRef {
  provider: ProviderName;
  id: string;
}
/** Parses a {@link PluginRef}. */
export const PluginRefSchema: z.ZodType<PluginRef, PluginRef> = z
  .object({ provider: ProviderNameSchema, id: pluginTokenSchema("PluginRef.id") })
  .strict();

/**
 * One item a plugin carries. A hook is named by its event, which the view puts in
 * plain words; `description` is null where the item has none.
 */
export interface PluginItem {
  name: string;
  description: string | null;
}
/** Parses a {@link PluginItem}. */
export const PluginItemSchema: z.ZodType<PluginItem> = z
  .object({ name: z.string().min(1), description: z.string().nullable() })
  .strict();

/** Every item a plugin carries, by kind. */
export interface PluginCarriedItems {
  agents: PluginItem[];
  skills: PluginItem[];
  mcpServers: PluginItem[];
  hooks: PluginItem[];
}
/** Parses {@link PluginCarriedItems}. */
export const PluginCarriedItemsSchema: z.ZodType<PluginCarriedItems> = z
  .object({
    agents: z.array(PluginItemSchema),
    skills: z.array(PluginItemSchema),
    mcpServers: z.array(PluginItemSchema),
    hooks: z.array(PluginItemSchema),
  })
  .strict();

/**
 * Where a plugin comes from: its marketplace, and for a plugin fetched from
 * elsewhere, the repository and the commit it was fetched at, always together.
 */
export interface PluginSource {
  marketplace: string;
  repository?: string | undefined;
  commit?: string | undefined;
}
/** Parses a {@link PluginSource}. */
export const PluginSourceSchema: z.ZodType<PluginSource> = z
  .object({
    marketplace: pluginTokenSchema("PluginSource.marketplace"),
    repository: wireFreeFormString(FILE_PATH_MAX_LEN, "PluginSource.repository").optional(),
    commit: pluginTokenSchema("PluginSource.commit").optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.repository === undefined) !== (source.commit === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["commit"],
        message: "A plugin fetched from a repository names the repository and its commit together.",
      });
    }
  });

/** What one plugin carries, each item by name and description, and its source. */
export interface PluginReadResponse {
  items: PluginCarriedItems;
  source: PluginSource;
}
/** Parses a {@link PluginReadResponse}. */
export const PluginReadResponseSchema: z.ZodType<PluginReadResponse> = z
  .object({ items: PluginCarriedItemsSchema, source: PluginSourceSchema })
  .strict();

// plugin.install and plugin.uninstall

/**
 * The installed plugin. The same verb serves a plugin installed in the person's own
 * terminal: it installs that plugin, from the same marketplace, into the daemon's
 * plugin home. An install reaches a live session the way a saved agent does.
 */
export interface PluginInstallResponse {
  plugin: PluginSummary;
}
/** Parses a {@link PluginInstallResponse}. */
export const PluginInstallResponseSchema: z.ZodType<PluginInstallResponse> = z
  .object({ plugin: PluginSummarySchema })
  .strict();

/** A removal's answer. */
export interface PluginUninstallResponse {
  uninstalled: true;
}
/** Parses a {@link PluginUninstallResponse}. */
export const PluginUninstallResponseSchema: z.ZodType<PluginUninstallResponse> = z
  .object({ uninstalled: z.literal(true) })
  .strict();

// plugin.installedList

/** The installed plugins of one provider, or of both when `provider` is absent. */
export interface PluginInstalledListRequest {
  provider?: ProviderName | undefined;
}
/** Parses a {@link PluginInstalledListRequest}. */
export const PluginInstalledListRequestSchema: z.ZodType<
  PluginInstalledListRequest,
  PluginInstalledListRequest
> = z.object({ provider: ProviderNameSchema.optional() }).strict();

/**
 * The plugins installed in the daemon's plugin homes, and those installed in the
 * person's own terminal, each saying which.
 */
export interface PluginInstalledListResponse {
  plugins: PluginSummary[];
}
/** Parses a {@link PluginInstalledListResponse}. */
export const PluginInstalledListResponseSchema: z.ZodType<PluginInstalledListResponse> = z
  .object({ plugins: z.array(PluginSummarySchema) })
  .strict();

// plugin.marketplaceAdd and plugin.marketplaceRemove

/**
 * Adds a marketplace by a repository address or a folder, through the provider's
 * own verb. A folder is picked with the platform's own chooser; the desktop main
 * process puts its path in place of the chooser's token. Each provider's official marketplace
 * is there without adding it.
 */
export interface PluginMarketplaceAddRequest {
  provider: ProviderName;
  source: string;
}
/** Parses a {@link PluginMarketplaceAddRequest}. */
export const PluginMarketplaceAddRequestSchema: z.ZodType<
  PluginMarketplaceAddRequest,
  PluginMarketplaceAddRequest
> = z
  .object({
    provider: ProviderNameSchema,
    source: wireFreeFormString(FILE_PATH_MAX_LEN, "PluginMarketplaceAddRequest.source"),
  })
  .strict();

/** The name the provider gave the added marketplace. */
export interface PluginMarketplaceAddResponse {
  name: string;
}
/** Parses a {@link PluginMarketplaceAddResponse}. */
export const PluginMarketplaceAddResponseSchema: z.ZodType<PluginMarketplaceAddResponse> = z
  .object({ name: pluginTokenSchema("PluginMarketplaceAddResponse.name") })
  .strict();

/** Removes a marketplace by the name its provider gave it. */
export interface PluginMarketplaceRemoveRequest {
  provider: ProviderName;
  name: string;
}
/** Parses a {@link PluginMarketplaceRemoveRequest}. */
export const PluginMarketplaceRemoveRequestSchema: z.ZodType<
  PluginMarketplaceRemoveRequest,
  PluginMarketplaceRemoveRequest
> = z
  .object({
    provider: ProviderNameSchema,
    name: pluginTokenSchema("PluginMarketplaceRemoveRequest.name"),
  })
  .strict();

/** A marketplace removal's answer. */
export interface PluginMarketplaceRemoveResponse {
  removed: true;
}
/** Parses a {@link PluginMarketplaceRemoveResponse}. */
export const PluginMarketplaceRemoveResponseSchema: z.ZodType<PluginMarketplaceRemoveResponse> = z
  .object({ removed: z.literal(true) })
  .strict();

// plugin.appList

/**
 * A Codex plugin's apps. An app is a tool server its provider hosts, reached
 * through a Codex account's ChatGPT sign-in, so its link is kept per account and
 * every linked app reaches every session on that account without loading anything.
 */
export interface PluginAppListRequest {
  provider: "codex";
  pluginId: string;
}
/** Parses a {@link PluginAppListRequest}. */
export const PluginAppListRequestSchema: z.ZodType<PluginAppListRequest, PluginAppListRequest> = z
  .object({
    provider: z.literal("codex"),
    pluginId: pluginTokenSchema("PluginAppListRequest.pluginId"),
  })
  .strict();

/**
 * One Codex account's link to an app. `connectUrl` is the app's page on the
 * provider's site, where the person links it while signed in as that account; the
 * view opens it in the browser and reads the list again when the window regains
 * focus. An account signed in with an API key answers no apps, so it has no line.
 */
export interface PluginAppAccountLink {
  providerAccountId: ProviderAccountId;
  linked: boolean;
  connectUrl: string;
}
/** Parses a {@link PluginAppAccountLink}. */
export const PluginAppAccountLinkSchema: z.ZodType<PluginAppAccountLink> = z
  .object({
    providerAccountId: ProviderAccountIdSchema,
    linked: z.boolean(),
    connectUrl: z.url({ protocol: /^https$/u }),
  })
  .strict();

/** One app a plugin carries, and its link on each Codex account. */
export interface PluginApp {
  appId: string;
  name: string;
  accounts: PluginAppAccountLink[];
}
/** Parses a {@link PluginApp}. */
export const PluginAppSchema: z.ZodType<PluginApp> = z
  .object({
    appId: pluginTokenSchema("PluginApp.appId"),
    name: z.string().min(1),
    accounts: z.array(PluginAppAccountLinkSchema),
  })
  .strict();

/** The plugin's apps. */
export interface PluginAppListResponse {
  apps: PluginApp[];
}
/** Parses a {@link PluginAppListResponse}. */
export const PluginAppListResponseSchema: z.ZodType<PluginAppListResponse> = z
  .object({ apps: z.array(PluginAppSchema) })
  .strict();

// The plugin.* method table

/** The `plugin.*` methods. */
export interface PluginMethodDescriptors {
  readonly "plugin.catalogList": MethodDescriptor<
    "plugin.catalogList",
    PluginCatalogListRequest,
    PluginCatalogListResponse
  >;
  readonly "plugin.read": MethodDescriptor<"plugin.read", PluginRef, PluginReadResponse>;
  readonly "plugin.install": MethodDescriptor<"plugin.install", PluginRef, PluginInstallResponse>;
  readonly "plugin.uninstall": MethodDescriptor<
    "plugin.uninstall",
    PluginRef,
    PluginUninstallResponse
  >;
  readonly "plugin.installedList": MethodDescriptor<
    "plugin.installedList",
    PluginInstalledListRequest,
    PluginInstalledListResponse
  >;
  readonly "plugin.marketplaceAdd": MethodDescriptor<
    "plugin.marketplaceAdd",
    PluginMarketplaceAddRequest,
    PluginMarketplaceAddResponse
  >;
  readonly "plugin.marketplaceRemove": MethodDescriptor<
    "plugin.marketplaceRemove",
    PluginMarketplaceRemoveRequest,
    PluginMarketplaceRemoveResponse
  >;
  readonly "plugin.appList": MethodDescriptor<
    "plugin.appList",
    PluginAppListRequest,
    PluginAppListResponse
  >;
}

/** The `plugin.*` method table. */
export const PLUGIN_METHOD_DESCRIPTORS: PluginMethodDescriptors = defineMethodDescriptors({
  "plugin.catalogList": {
    method: "plugin.catalogList",
    procedureType: "query",
    mutating: false,
    requestSchema: PluginCatalogListRequestSchema,
    responseSchema: PluginCatalogListResponseSchema,
  },
  "plugin.read": {
    method: "plugin.read",
    procedureType: "query",
    mutating: false,
    requestSchema: PluginRefSchema,
    responseSchema: PluginReadResponseSchema,
  },
  "plugin.install": {
    method: "plugin.install",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PluginRefSchema,
    responseSchema: PluginInstallResponseSchema,
  },
  "plugin.uninstall": {
    method: "plugin.uninstall",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PluginRefSchema,
    responseSchema: PluginUninstallResponseSchema,
  },
  "plugin.installedList": {
    method: "plugin.installedList",
    procedureType: "query",
    mutating: false,
    requestSchema: PluginInstalledListRequestSchema,
    responseSchema: PluginInstalledListResponseSchema,
  },
  "plugin.marketplaceAdd": {
    method: "plugin.marketplaceAdd",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PluginMarketplaceAddRequestSchema,
    responseSchema: PluginMarketplaceAddResponseSchema,
  },
  "plugin.marketplaceRemove": {
    method: "plugin.marketplaceRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: PluginMarketplaceRemoveRequestSchema,
    responseSchema: PluginMarketplaceRemoveResponseSchema,
  },
  "plugin.appList": {
    method: "plugin.appList",
    procedureType: "query",
    mutating: false,
    requestSchema: PluginAppListRequestSchema,
    responseSchema: PluginAppListResponseSchema,
  },
});
