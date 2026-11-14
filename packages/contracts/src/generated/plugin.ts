// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Plugins: each provider's catalog, what one plugin carries, installing and removing it, the installed list, marketplaces, and a plugin's apps per provider account.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../schema-check.js";
import { type ProviderAccountId, validateProviderAccountId } from "./provider/account/record.js";
import { type ProviderId, validateProviderId } from "./provider/id.js";

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

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link PluginSummary}. */
// prettier-ignore
export const validatePluginSummary: CompiledSchemaCheck<PluginSummary> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginSummary.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.marketplace === undefined) && (missing0 = "marketplace"))) || ((data.installed === undefined) && (missing0 = "installed"))) || ((data.installedInTerminal === undefined) && (missing0 = "installedInTerminal"))){validatePluginSummary.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "id") || (key0 === "provider")) || (key0 === "name")) || (key0 === "displayName")) || (key0 === "description")) || (key0 === "marketplace")) || (key0 === "installed")) || (key0 === "installedInTerminal"))){validatePluginSummary.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validatePluginSummary.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validatePluginSummary.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePluginSummary.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSummary.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validatePluginSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validatePluginSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validatePluginSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSummary.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) < 1){validatePluginSummary.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePluginSummary.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs9: any = errors;if(typeof data.description !== "string"){validatePluginSummary.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.marketplace !== undefined){let data5: any = data.marketplace;const _errs11: any = errors;if(errors === _errs11){if(typeof data5 === "string"){if(func1(data5) > 128){validatePluginSummary.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validatePluginSummary.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validatePluginSummary.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSummary.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.installed !== undefined){const _errs13: any = errors;if(typeof data.installed !== "boolean"){validatePluginSummary.errors = [{instancePath:instancePath+"/installed",schemaPath:"#/properties/installed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.installedInTerminal !== undefined){const _errs15: any = errors;if(typeof data.installedInTerminal !== "boolean"){validatePluginSummary.errors = [{instancePath:instancePath+"/installedInTerminal",schemaPath:"#/properties/installedInTerminal/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validatePluginSummary.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginSummary.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginSummary.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginCarriedCounts}. */
// prettier-ignore
export const validatePluginCarriedCounts: CompiledSchemaCheck<PluginCarriedCounts> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCarriedCounts {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginCarriedCounts.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.agents === undefined) && (missing0 = "agents")) || ((data.skills === undefined) && (missing0 = "skills"))) || ((data.mcpServers === undefined) && (missing0 = "mcpServers"))) || ((data.hooks === undefined) && (missing0 = "hooks"))){validatePluginCarriedCounts.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "agents") || (key0 === "skills")) || (key0 === "mcpServers")) || (key0 === "hooks"))){validatePluginCarriedCounts.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.agents !== undefined){let data0: any = data.agents;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data1: any = data.skills;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.mcpServers !== undefined){let data2: any = data.mcpServers;const _errs6: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/mcpServers",schemaPath:"#/properties/mcpServers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/mcpServers",schemaPath:"#/properties/mcpServers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/mcpServers",schemaPath:"#/properties/mcpServers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.hooks !== undefined){let data3: any = data.hooks;const _errs8: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validatePluginCarriedCounts.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validatePluginCarriedCounts.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginCarriedCounts.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginCarriedCounts.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema791: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The provider's id for it."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"Its provider."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"Its name."},"displayName":{"type":"string","minLength":1,"description":"The name a person reads."},"description":{"type":"string","description":"Its one-line description."},"marketplace":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The marketplace it comes from."},"installed":{"type":"boolean","description":"Whether it is installed in the daemon's plugin home."},"installedInTerminal":{"type":"boolean","description":"Whether it is installed in the person's own terminal, independent of `installed`."},"carries":{"$ref":"#/$defs/PluginCarriedCounts","description":"What it carries."}},"required":["id","provider","name","displayName","description","marketplace","installed","installedInTerminal","carries"],"description":"One catalog row: the plugin, and what it carries."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link PluginCatalogEntry}. */
// prettier-ignore
export const validatePluginCatalogEntry: CompiledSchemaCheck<PluginCatalogEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCatalogEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginCatalogEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.marketplace === undefined) && (missing0 = "marketplace"))) || ((data.installed === undefined) && (missing0 = "installed"))) || ((data.installedInTerminal === undefined) && (missing0 = "installedInTerminal"))) || ((data.carries === undefined) && (missing0 = "carries"))){validatePluginCatalogEntry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema791.properties, key0))){validatePluginCatalogEntry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) < 1){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs9: any = errors;if(typeof data.description !== "string"){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.marketplace !== undefined){let data5: any = data.marketplace;const _errs11: any = errors;if(errors === _errs11){if(typeof data5 === "string"){if(func1(data5) > 128){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.installed !== undefined){const _errs13: any = errors;if(typeof data.installed !== "boolean"){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/installed",schemaPath:"#/properties/installed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.installedInTerminal !== undefined){const _errs15: any = errors;if(typeof data.installedInTerminal !== "boolean"){validatePluginCatalogEntry.errors = [{instancePath:instancePath+"/installedInTerminal",schemaPath:"#/properties/installedInTerminal/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.carries !== undefined){const _errs17: any = errors;if(!(validatePluginCarriedCounts.call(this, data.carries, {instancePath:instancePath+"/carries",parentData:data,parentDataProperty:"carries",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginCarriedCounts.errors : vErrors.concat(validatePluginCarriedCounts.errors);errors = vErrors.length;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validatePluginCatalogEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginCatalogEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginCatalogEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginCatalogListRequest}. */
// prettier-ignore
export const validatePluginCatalogListRequest: CompiledSchemaCheck<PluginCatalogListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCatalogListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginCatalogListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.provider === undefined) && (missing0 = "provider")){validatePluginCatalogListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "query")) || (key0 === "cursor"))){validatePluginCatalogListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.query !== undefined){let data1: any = data.query;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}else {validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){let data2: any = data.cursor;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginCatalogListRequest.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validatePluginCatalogListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginCatalogListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginCatalogListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginCatalogListResponse}. */
// prettier-ignore
export const validatePluginCatalogListResponse: CompiledSchemaCheck<PluginCatalogListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCatalogListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginCatalogListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugins === undefined) && (missing0 = "plugins")){validatePluginCatalogListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "plugins") || (key0 === "nextCursor"))){validatePluginCatalogListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugins !== undefined){let data0: any = data.plugins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePluginCatalogEntry.call(this, data0[i0], {instancePath:instancePath+"/plugins/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginCatalogEntry.errors : vErrors.concat(validatePluginCatalogEntry.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePluginCatalogListResponse.errors = [{instancePath:instancePath+"/plugins",schemaPath:"#/properties/plugins/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nextCursor !== undefined){let data2: any = data.nextCursor;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validatePluginCatalogListResponse.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validatePluginCatalogListResponse.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validatePluginCatalogListResponse.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginCatalogListResponse.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validatePluginCatalogListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginCatalogListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginCatalogListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginRef}. */
// prettier-ignore
export const validatePluginRef: CompiledSchemaCheck<PluginRef> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginRef {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginRef.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.id === undefined) && (missing0 = "id"))){validatePluginRef.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "id"))){validatePluginRef.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validatePluginRef.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validatePluginRef.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginRef.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginRef.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePluginRef.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginRef.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginRef.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginInstallRequest}. */
// prettier-ignore
export const validatePluginInstallRequest: CompiledSchemaCheck<PluginInstallRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstallRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginInstallRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.id === undefined) && (missing0 = "id"))){validatePluginInstallRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "id")) || (key0 === "options"))){validatePluginInstallRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginInstallRequest.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data2: any = data.options;const _errs5: any = errors;if(errors === _errs5){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){for(const key1 in data2){const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof key1 === "string"){if(func1(key1) > 128){const err0: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/maxLength",keyword:"maxLength",params:{limit: 128},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(func1(key1) < 1){const err1: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/minLength",keyword:"minLength",params:{limit: 1},propertyName:key1};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(!pattern5.test(key1)){const err2: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}else {const err3: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid2: any = _errs8 === errors;if(valid2){const _errs10: any = errors;const _errs11: any = errors;const _errs12: any = errors;if("__proto__" !== key1){const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid3: any = _errs12 === errors;if(valid3){const err5: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {errors = _errs11;if(vErrors !== null){if(_errs11){vErrors.length = _errs11;}else {vErrors = null;}}}var valid2: any = _errs10 === errors;}var valid1: any = _errs7 === errors;if(!valid1){const err6: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validatePluginInstallRequest.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data2){let data3: any = data2[key2];const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(func1(data3) > 4096){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validatePluginInstallRequest.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginInstallRequest.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs14 === errors;if(!valid4){break;}}}}else {validatePluginInstallRequest.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validatePluginInstallRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginInstallRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginInstallRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema804: any = {"type":"object","additionalProperties":false,"properties":{"name":{"type":"string","minLength":1,"description":"Its name."},"description":{"type":["string","null"],"description":"Its description, or `null`."}},"required":["name","description"],"description":"One item a plugin carries. A hook is named by its event, which the view puts in plain words;\n`description` is `null` where the item has none."};
/** Checks that a value is a {@link PluginItem}. */
// prettier-ignore
export const validatePluginItem: CompiledSchemaCheck<PluginItem> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginItem {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginItem.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.name === undefined) && (missing0 = "name")) || ((data.description === undefined) && (missing0 = "description"))){validatePluginItem.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "name") || (key0 === "description"))){validatePluginItem.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validatePluginItem.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePluginItem.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data1: any = data.description;const _errs4: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validatePluginItem.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: schema804.properties.description.type}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validatePluginItem.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginItem.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginItem.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginCarriedItems}. */
// prettier-ignore
export const validatePluginCarriedItems: CompiledSchemaCheck<PluginCarriedItems> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCarriedItems {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginCarriedItems.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.agents === undefined) && (missing0 = "agents")) || ((data.skills === undefined) && (missing0 = "skills"))) || ((data.mcpServers === undefined) && (missing0 = "mcpServers"))) || ((data.hooks === undefined) && (missing0 = "hooks"))){validatePluginCarriedItems.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "agents") || (key0 === "skills")) || (key0 === "mcpServers")) || (key0 === "hooks"))){validatePluginCarriedItems.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.agents !== undefined){let data0: any = data.agents;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePluginItem.call(this, data0[i0], {instancePath:instancePath+"/agents/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginItem.errors : vErrors.concat(validatePluginItem.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePluginCarriedItems.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data2: any = data.skills;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data2)){var valid2: any = true;const len1: any = data2.length;for(let i1=0; i1<len1; i1++){const _errs7: any = errors;if(!(validatePluginItem.call(this, data2[i1], {instancePath:instancePath+"/skills/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginItem.errors : vErrors.concat(validatePluginItem.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validatePluginCarriedItems.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.mcpServers !== undefined){let data4: any = data.mcpServers;const _errs8: any = errors;if(errors === _errs8){if(Array.isArray(data4)){var valid3: any = true;const len2: any = data4.length;for(let i2=0; i2<len2; i2++){const _errs10: any = errors;if(!(validatePluginItem.call(this, data4[i2], {instancePath:instancePath+"/mcpServers/" + i2,parentData:data4,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginItem.errors : vErrors.concat(validatePluginItem.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;if(!valid3){break;}}}else {validatePluginCarriedItems.errors = [{instancePath:instancePath+"/mcpServers",schemaPath:"#/properties/mcpServers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.hooks !== undefined){let data6: any = data.hooks;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data6)){var valid4: any = true;const len3: any = data6.length;for(let i3=0; i3<len3; i3++){const _errs13: any = errors;if(!(validatePluginItem.call(this, data6[i3], {instancePath:instancePath+"/hooks/" + i3,parentData:data6,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginItem.errors : vErrors.concat(validatePluginItem.errors);errors = vErrors.length;}var valid4: any = _errs13 === errors;if(!valid4){break;}}}else {validatePluginCarriedItems.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validatePluginCarriedItems.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginCarriedItems.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginCarriedItems.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginSource}. */
// prettier-ignore
export const validatePluginSource: CompiledSchemaCheck<PluginSource> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginSource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.marketplace === undefined) && (missing0 = "marketplace")){validatePluginSource.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "marketplace") || (key0 === "repository")) || (key0 === "commit"))){validatePluginSource.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.marketplace !== undefined){let data0: any = data.marketplace;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validatePluginSource.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validatePluginSource.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePluginSource.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSource.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repository !== undefined){let data1: any = data.repository;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validatePluginSource.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validatePluginSource.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginSource.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSource.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.commit !== undefined){let data2: any = data.commit;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 128){validatePluginSource.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validatePluginSource.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validatePluginSource.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginSource.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.repository !== undefined && ((data.commit === undefined) && (missing1 = "commit"))){validatePluginSource.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repository",
    missingProperty: missing1,
    depsCount: 1,
    deps: "commit"}}];return false;}else {if(data.commit !== undefined && ((data.repository === undefined) && (missing1 = "repository"))){validatePluginSource.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "commit",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repository"}}];return false;}}}}}}}}else {validatePluginSource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginSource.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginSource.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginReadResponse}. */
// prettier-ignore
export const validatePluginReadResponse: CompiledSchemaCheck<PluginReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.items === undefined) && (missing0 = "items")) || ((data.source === undefined) && (missing0 = "source"))){validatePluginReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "items") || (key0 === "source"))){validatePluginReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.items !== undefined){const _errs2: any = errors;if(!(validatePluginCarriedItems.call(this, data.items, {instancePath:instancePath+"/items",parentData:data,parentDataProperty:"items",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginCarriedItems.errors : vErrors.concat(validatePluginCarriedItems.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){const _errs3: any = errors;if(!(validatePluginSource.call(this, data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginSource.errors : vErrors.concat(validatePluginSource.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePluginReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginInstallResponse}. */
// prettier-ignore
export const validatePluginInstallResponse: CompiledSchemaCheck<PluginInstallResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstallResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginInstallResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugin === undefined) && (missing0 = "plugin")){validatePluginInstallResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "plugin")){validatePluginInstallResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugin !== undefined){if(!(validatePluginSummary.call(this, data.plugin, {instancePath:instancePath+"/plugin",parentData:data,parentDataProperty:"plugin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginSummary.errors : vErrors.concat(validatePluginSummary.errors);errors = vErrors.length;}}}}}else {validatePluginInstallResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginInstallResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginInstallResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginUninstallResponse}. */
// prettier-ignore
export const validatePluginUninstallResponse: CompiledSchemaCheck<PluginUninstallResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginUninstallResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginUninstallResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.uninstalled === undefined) && (missing0 = "uninstalled")){validatePluginUninstallResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "uninstalled")){validatePluginUninstallResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.uninstalled !== undefined){let data0: any = data.uninstalled;if(typeof data0 !== "boolean"){validatePluginUninstallResponse.errors = [{instancePath:instancePath+"/uninstalled",schemaPath:"#/properties/uninstalled/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePluginUninstallResponse.errors = [{instancePath:instancePath+"/uninstalled",schemaPath:"#/properties/uninstalled/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePluginUninstallResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginUninstallResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginUninstallResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginInstalledListRequest}. */
// prettier-ignore
export const validatePluginInstalledListRequest: CompiledSchemaCheck<PluginInstalledListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstalledListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginInstalledListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "provider")){validatePluginInstalledListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}}}}else {validatePluginInstalledListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginInstalledListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginInstalledListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginInstalledListResponse}. */
// prettier-ignore
export const validatePluginInstalledListResponse: CompiledSchemaCheck<PluginInstalledListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstalledListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginInstalledListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugins === undefined) && (missing0 = "plugins")){validatePluginInstalledListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "plugins")){validatePluginInstalledListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugins !== undefined){let data0: any = data.plugins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePluginSummary.call(this, data0[i0], {instancePath:instancePath+"/plugins/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginSummary.errors : vErrors.concat(validatePluginSummary.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePluginInstalledListResponse.errors = [{instancePath:instancePath+"/plugins",schemaPath:"#/properties/plugins/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePluginInstalledListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginInstalledListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginInstalledListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginMarketplaceAddRequest}. */
// prettier-ignore
export const validatePluginMarketplaceAddRequest: CompiledSchemaCheck<PluginMarketplaceAddRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginMarketplaceAddRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.source === undefined) && (missing0 = "source"))){validatePluginMarketplaceAddRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "source"))){validatePluginMarketplaceAddRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){let data1: any = data.source;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validatePluginMarketplaceAddRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validatePluginMarketplaceAddRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginMarketplaceAddRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginMarketplaceAddRequest.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePluginMarketplaceAddRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginMarketplaceAddRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginMarketplaceAddRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginMarketplaceAddResponse}. */
// prettier-ignore
export const validatePluginMarketplaceAddResponse: CompiledSchemaCheck<PluginMarketplaceAddResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginMarketplaceAddResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.name === undefined) && (missing0 = "name")){validatePluginMarketplaceAddResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "name")){validatePluginMarketplaceAddResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validatePluginMarketplaceAddResponse.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validatePluginMarketplaceAddResponse.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePluginMarketplaceAddResponse.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginMarketplaceAddResponse.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validatePluginMarketplaceAddResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginMarketplaceAddResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginMarketplaceAddResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginMarketplaceRemoveRequest}. */
// prettier-ignore
export const validatePluginMarketplaceRemoveRequest: CompiledSchemaCheck<PluginMarketplaceRemoveRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceRemoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginMarketplaceRemoveRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))){validatePluginMarketplaceRemoveRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "name"))){validatePluginMarketplaceRemoveRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validatePluginMarketplaceRemoveRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validatePluginMarketplaceRemoveRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginMarketplaceRemoveRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginMarketplaceRemoveRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePluginMarketplaceRemoveRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginMarketplaceRemoveRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginMarketplaceRemoveRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginMarketplaceRemoveResponse}. */
// prettier-ignore
export const validatePluginMarketplaceRemoveResponse: CompiledSchemaCheck<PluginMarketplaceRemoveResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginMarketplaceRemoveResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removed === undefined) && (missing0 = "removed")){validatePluginMarketplaceRemoveResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removed")){validatePluginMarketplaceRemoveResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removed !== undefined){let data0: any = data.removed;if(typeof data0 !== "boolean"){validatePluginMarketplaceRemoveResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validatePluginMarketplaceRemoveResponse.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validatePluginMarketplaceRemoveResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginMarketplaceRemoveResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginMarketplaceRemoveResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginAppListRequest}. */
// prettier-ignore
export const validatePluginAppListRequest: CompiledSchemaCheck<PluginAppListRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginAppListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginAppListRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.pluginId === undefined) && (missing0 = "pluginId"))){validatePluginAppListRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "pluginId"))){validatePluginAppListRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pluginId !== undefined){let data1: any = data.pluginId;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validatePluginAppListRequest.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validatePluginAppListRequest.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validatePluginAppListRequest.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginAppListRequest.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validatePluginAppListRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginAppListRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginAppListRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link PluginAppAccountLink}. */
// prettier-ignore
export const validatePluginAppAccountLink: CompiledSchemaCheck<PluginAppAccountLink> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginAppAccountLink {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginAppAccountLink.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerAccountId === undefined) && (missing0 = "providerAccountId")) || ((data.linked === undefined) && (missing0 = "linked"))) || ((data.connectUrl === undefined) && (missing0 = "connectUrl"))){validatePluginAppAccountLink.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "providerAccountId") || (key0 === "linked")) || (key0 === "connectUrl"))){validatePluginAppAccountLink.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerAccountId !== undefined){const _errs2: any = errors;if(!(validateProviderAccountId.call(this, data.providerAccountId, {instancePath:instancePath+"/providerAccountId",parentData:data,parentDataProperty:"providerAccountId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderAccountId.errors : vErrors.concat(validateProviderAccountId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.linked !== undefined){const _errs3: any = errors;if(typeof data.linked !== "boolean"){validatePluginAppAccountLink.errors = [{instancePath:instancePath+"/linked",schemaPath:"#/properties/linked/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.connectUrl !== undefined){let data2: any = data.connectUrl;const _errs5: any = errors;if(errors === _errs5){if(errors === _errs5){if(typeof data2 === "string"){if(!pattern33.test(data2)){validatePluginAppAccountLink.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data2))){validatePluginAppAccountLink.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validatePluginAppAccountLink.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validatePluginAppAccountLink.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginAppAccountLink.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginAppAccountLink.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginApp}. */
// prettier-ignore
export const validatePluginApp: CompiledSchemaCheck<PluginApp> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginApp {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginApp.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.appId === undefined) && (missing0 = "appId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.accounts === undefined) && (missing0 = "accounts"))){validatePluginApp.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "appId") || (key0 === "name")) || (key0 === "accounts"))){validatePluginApp.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.appId !== undefined){let data0: any = data.appId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validatePluginApp.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validatePluginApp.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validatePluginApp.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validatePluginApp.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validatePluginApp.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validatePluginApp.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.accounts !== undefined){let data2: any = data.accounts;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validatePluginAppAccountLink.call(this, data2[i0], {instancePath:instancePath+"/accounts/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginAppAccountLink.errors : vErrors.concat(validatePluginAppAccountLink.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validatePluginApp.errors = [{instancePath:instancePath+"/accounts",schemaPath:"#/properties/accounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validatePluginApp.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginApp.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginApp.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginAppListResponse}. */
// prettier-ignore
export const validatePluginAppListResponse: CompiledSchemaCheck<PluginAppListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginAppListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validatePluginAppListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.apps === undefined) && (missing0 = "apps")){validatePluginAppListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "apps")){validatePluginAppListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.apps !== undefined){let data0: any = data.apps;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validatePluginApp.call(this, data0[i0], {instancePath:instancePath+"/apps/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePluginApp.errors : vErrors.concat(validatePluginApp.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validatePluginAppListResponse.errors = [{instancePath:instancePath+"/apps",schemaPath:"#/properties/apps/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validatePluginAppListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validatePluginAppListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validatePluginAppListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link PLUGIN_METHOD_DESCRIPTORS}, each with its checks. */
export interface PluginMethodDescriptors {
  readonly "plugin.catalog.list": {
    readonly method: "plugin.catalog.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PluginCatalogListRequest>;
    readonly responseCheck: SchemaCheck<PluginCatalogListResponse>;
  };
  readonly "plugin.read": {
    readonly method: "plugin.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PluginRef>;
    readonly responseCheck: SchemaCheck<PluginReadResponse>;
  };
  readonly "plugin.install": {
    readonly method: "plugin.install";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PluginInstallRequest>;
    readonly responseCheck: SchemaCheck<PluginInstallResponse>;
  };
  readonly "plugin.uninstall": {
    readonly method: "plugin.uninstall";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PluginRef>;
    readonly responseCheck: SchemaCheck<PluginUninstallResponse>;
  };
  readonly "plugin.installed.list": {
    readonly method: "plugin.installed.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PluginInstalledListRequest>;
    readonly responseCheck: SchemaCheck<PluginInstalledListResponse>;
  };
  readonly "plugin.marketplace.add": {
    readonly method: "plugin.marketplace.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PluginMarketplaceAddRequest>;
    readonly responseCheck: SchemaCheck<PluginMarketplaceAddResponse>;
  };
  readonly "plugin.marketplace.remove": {
    readonly method: "plugin.marketplace.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<PluginMarketplaceRemoveRequest>;
    readonly responseCheck: SchemaCheck<PluginMarketplaceRemoveResponse>;
  };
  readonly "plugin.app.list": {
    readonly method: "plugin.app.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<PluginAppListRequest>;
    readonly responseCheck: SchemaCheck<PluginAppListResponse>;
  };
}
/** The `plugin.*` methods. */
export const PLUGIN_METHOD_DESCRIPTORS: PluginMethodDescriptors = Object.freeze({
  "plugin.catalog.list": Object.freeze({
    method: "plugin.catalog.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validatePluginCatalogListRequest,
    responseCheck: validatePluginCatalogListResponse,
  }),
  "plugin.read": Object.freeze({
    method: "plugin.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validatePluginRef,
    responseCheck: validatePluginReadResponse,
  }),
  "plugin.install": Object.freeze({
    method: "plugin.install",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePluginInstallRequest,
    responseCheck: validatePluginInstallResponse,
  }),
  "plugin.uninstall": Object.freeze({
    method: "plugin.uninstall",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePluginRef,
    responseCheck: validatePluginUninstallResponse,
  }),
  "plugin.installed.list": Object.freeze({
    method: "plugin.installed.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validatePluginInstalledListRequest,
    responseCheck: validatePluginInstalledListResponse,
  }),
  "plugin.marketplace.add": Object.freeze({
    method: "plugin.marketplace.add",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePluginMarketplaceAddRequest,
    responseCheck: validatePluginMarketplaceAddResponse,
  }),
  "plugin.marketplace.remove": Object.freeze({
    method: "plugin.marketplace.remove",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validatePluginMarketplaceRemoveRequest,
    responseCheck: validatePluginMarketplaceRemoveResponse,
  }),
  "plugin.app.list": Object.freeze({
    method: "plugin.app.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validatePluginAppListRequest,
    responseCheck: validatePluginAppListResponse,
  }),
});
