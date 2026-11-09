// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Plugins: each provider's catalog, what one plugin carries, installing and removing it, the installed list, marketplaces, and a plugin's apps per provider account.

import { SCHEMA_FORMATS, type SchemaCheck, ucs2length } from "../schema-check.js";
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

// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1261(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginAppListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1261.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.pluginId === undefined) && (missing0 = "pluginId"))){validate1261.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "pluginId"))){validate1261.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1261.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1261.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.pluginId !== undefined){let data1: any = data.pluginId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1261.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1261.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1261.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1261.errors = [{instancePath:instancePath+"/pluginId",schemaPath:"#/properties/pluginId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1261.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1261.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1261.errors = null as any[] | null;
// prettier-ignore
validate1261.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1264(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1264.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerAccountId === undefined) && (missing0 = "providerAccountId")) || ((data.linked === undefined) && (missing0 = "linked"))) || ((data.connectUrl === undefined) && (missing0 = "connectUrl"))){validate1264.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "providerAccountId") || (key0 === "linked")) || (key0 === "connectUrl"))){validate1264.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerAccountId !== undefined){let data0: any = data.providerAccountId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate1264.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate1264.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1264.errors = [{instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.linked !== undefined){const _errs6: any = errors;if(typeof data.linked !== "boolean"){validate1264.errors = [{instancePath:instancePath+"/linked",schemaPath:"#/properties/linked/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.connectUrl !== undefined){let data2: any = data.connectUrl;const _errs8: any = errors;if(errors === _errs8){if(errors === _errs8){if(typeof data2 === "string"){if(!pattern43.test(data2)){validate1264.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data2))){validate1264.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validate1264.errors = [{instancePath:instancePath+"/connectUrl",schemaPath:"#/properties/connectUrl/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1264.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1264.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1264.errors = null as any[] | null;
// prettier-ignore
validate1264.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1263(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1263.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.appId === undefined) && (missing0 = "appId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.accounts === undefined) && (missing0 = "accounts"))){validate1263.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "appId") || (key0 === "name")) || (key0 === "accounts"))){validate1263.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.appId !== undefined){let data0: any = data.appId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1263.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1263.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1263.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1263.errors = [{instancePath:instancePath+"/appId",schemaPath:"#/properties/appId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validate1263.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1263.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.accounts !== undefined){let data2: any = data.accounts;const _errs6: any = errors;if(errors === _errs6){if(Array.isArray(data2)){var valid1: any = true;const len0: any = data2.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1264.call(this, data2[i0], {instancePath:instancePath+"/accounts/" + i0,parentData:data2,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1264.errors : vErrors.concat(validate1264.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;if(!valid1){break;}}}else {validate1263.errors = [{instancePath:instancePath+"/accounts",schemaPath:"#/properties/accounts/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1263.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1263.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1263.errors = null as any[] | null;
// prettier-ignore
validate1263.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1262(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginAppListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1262.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.apps === undefined) && (missing0 = "apps")){validate1262.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "apps")){validate1262.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.apps !== undefined){let data0: any = data.apps;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1263.call(this, data0[i0], {instancePath:instancePath+"/apps/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1263.errors : vErrors.concat(validate1263.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1262.errors = [{instancePath:instancePath+"/apps",schemaPath:"#/properties/apps/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1262.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1262.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1262.errors = null as any[] | null;
// prettier-ignore
validate1262.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1267(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCatalogListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1267.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.provider === undefined) && (missing0 = "provider")){validate1267.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "query")) || (key0 === "cursor"))){validate1267.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1267.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1267.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.query !== undefined){let data1: any = data.query;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1267.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}}else {validate1267.errors = [{instancePath:instancePath+"/query",schemaPath:"#/properties/query/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.cursor !== undefined){let data2: any = data.cursor;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1267.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1267.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1267.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1267.errors = [{instancePath:instancePath+"/cursor",schemaPath:"#/properties/cursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1267.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1267.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1267.errors = null as any[] | null;
// prettier-ignore
validate1267.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2379: any = {"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The provider's id for it."},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"Its provider."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"Its name."},"displayName":{"type":"string","minLength":1,"description":"The name a person reads."},"description":{"type":"string","description":"Its one-line description."},"marketplace":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The marketplace it comes from."},"installed":{"type":"boolean","description":"Whether it is installed in the daemon's plugin home."},"installedInTerminal":{"type":"boolean","description":"Whether it is installed in the person's own terminal, independent of `installed`."},"carries":{"$ref":"#/$defs/PluginCarriedCounts","description":"What it carries."}},"required":["id","provider","name","displayName","description","marketplace","installed","installedInTerminal","carries"],"description":"One catalog row: the plugin, and what it carries."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate1269(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1269.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.marketplace === undefined) && (missing0 = "marketplace"))) || ((data.installed === undefined) && (missing0 = "installed"))) || ((data.installedInTerminal === undefined) && (missing0 = "installedInTerminal"))) || ((data.carries === undefined) && (missing0 = "carries"))){validate1269.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema2379.properties, key0))){validate1269.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1269.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1269.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1269.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1269.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1269.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1269.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1269.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1269.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1269.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1269.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate1269.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1269.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs12: any = errors;if(typeof data.description !== "string"){validate1269.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.marketplace !== undefined){let data5: any = data.marketplace;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 128){validate1269.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1269.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1269.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1269.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.installed !== undefined){const _errs16: any = errors;if(typeof data.installed !== "boolean"){validate1269.errors = [{instancePath:instancePath+"/installed",schemaPath:"#/properties/installed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.installedInTerminal !== undefined){const _errs18: any = errors;if(typeof data.installedInTerminal !== "boolean"){validate1269.errors = [{instancePath:instancePath+"/installedInTerminal",schemaPath:"#/properties/installedInTerminal/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.carries !== undefined){let data8: any = data.carries;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(data8 && typeof data8 == "object" && !Array.isArray(data8)){let missing1: any;if(((((data8.agents === undefined) && (missing1 = "agents")) || ((data8.skills === undefined) && (missing1 = "skills"))) || ((data8.mcpServers === undefined) && (missing1 = "mcpServers"))) || ((data8.hooks === undefined) && (missing1 = "hooks"))){validate1269.errors = [{instancePath:instancePath+"/carries",schemaPath:"#/$defs/PluginCarriedCounts/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs23: any = errors;for(const key1 in data8){if(!((((key1 === "agents") || (key1 === "skills")) || (key1 === "mcpServers")) || (key1 === "hooks"))){validate1269.errors = [{instancePath:instancePath+"/carries",schemaPath:"#/$defs/PluginCarriedCounts/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data8.agents !== undefined){let data9: any = data8.agents;const _errs24: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate1269.errors = [{instancePath:instancePath+"/carries/agents",schemaPath:"#/$defs/PluginCarriedCounts/properties/agents/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate1269.errors = [{instancePath:instancePath+"/carries/agents",schemaPath:"#/$defs/PluginCarriedCounts/properties/agents/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate1269.errors = [{instancePath:instancePath+"/carries/agents",schemaPath:"#/$defs/PluginCarriedCounts/properties/agents/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs24 === errors;}else {var valid3: any = true;}if(valid3){if(data8.skills !== undefined){let data10: any = data8.skills;const _errs26: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate1269.errors = [{instancePath:instancePath+"/carries/skills",schemaPath:"#/$defs/PluginCarriedCounts/properties/skills/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs26){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate1269.errors = [{instancePath:instancePath+"/carries/skills",schemaPath:"#/$defs/PluginCarriedCounts/properties/skills/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate1269.errors = [{instancePath:instancePath+"/carries/skills",schemaPath:"#/$defs/PluginCarriedCounts/properties/skills/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs26 === errors;}else {var valid3: any = true;}if(valid3){if(data8.mcpServers !== undefined){let data11: any = data8.mcpServers;const _errs28: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate1269.errors = [{instancePath:instancePath+"/carries/mcpServers",schemaPath:"#/$defs/PluginCarriedCounts/properties/mcpServers/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs28){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate1269.errors = [{instancePath:instancePath+"/carries/mcpServers",schemaPath:"#/$defs/PluginCarriedCounts/properties/mcpServers/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate1269.errors = [{instancePath:instancePath+"/carries/mcpServers",schemaPath:"#/$defs/PluginCarriedCounts/properties/mcpServers/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs28 === errors;}else {var valid3: any = true;}if(valid3){if(data8.hooks !== undefined){let data12: any = data8.hooks;const _errs30: any = errors;if(!(((typeof data12 == "number") && (!(data12 % 1) && !isNaN(data12))) && (isFinite(data12)))){validate1269.errors = [{instancePath:instancePath+"/carries/hooks",schemaPath:"#/$defs/PluginCarriedCounts/properties/hooks/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs30){if((typeof data12 == "number") && (isFinite(data12))){if(data12 > 9007199254740991 || isNaN(data12)){validate1269.errors = [{instancePath:instancePath+"/carries/hooks",schemaPath:"#/$defs/PluginCarriedCounts/properties/hooks/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data12 < 0 || isNaN(data12)){validate1269.errors = [{instancePath:instancePath+"/carries/hooks",schemaPath:"#/$defs/PluginCarriedCounts/properties/hooks/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs30 === errors;}else {var valid3: any = true;}}}}}}}else {validate1269.errors = [{instancePath:instancePath+"/carries",schemaPath:"#/$defs/PluginCarriedCounts/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validate1269.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1269.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1269.errors = null as any[] | null;
// prettier-ignore
validate1269.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1268(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginCatalogListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1268.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugins === undefined) && (missing0 = "plugins")){validate1268.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "plugins") || (key0 === "nextCursor"))){validate1268.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugins !== undefined){let data0: any = data.plugins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1269.call(this, data0[i0], {instancePath:instancePath+"/plugins/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1269.errors : vErrors.concat(validate1269.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1268.errors = [{instancePath:instancePath+"/plugins",schemaPath:"#/properties/plugins/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.nextCursor !== undefined){let data2: any = data.nextCursor;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validate1268.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1268.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1268.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1268.errors = [{instancePath:instancePath+"/nextCursor",schemaPath:"#/properties/nextCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate1268.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1268.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1268.errors = null as any[] | null;
// prettier-ignore
validate1268.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1271(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstallRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1271.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.id === undefined) && (missing0 = "id"))){validate1271.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "provider") || (key0 === "id")) || (key0 === "options"))){validate1271.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1271.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1271.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1271.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1271.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1271.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1271.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data2: any = data.options;const _errs8: any = errors;if(errors === _errs8){if(data2 && typeof data2 == "object" && !Array.isArray(data2)){for(const key1 in data2){const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof key1 === "string"){if(func1(key1) > 128){const err0: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/maxLength",keyword:"maxLength",params:{limit: 128},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(func1(key1) < 1){const err1: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/minLength",keyword:"minLength",params:{limit: 1},propertyName:key1};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(!pattern6.test(key1)){const err2: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}}}else {const err3: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid3: any = _errs11 === errors;if(valid3){const _errs13: any = errors;const _errs14: any = errors;const _errs15: any = errors;if("__proto__" !== key1){const err4: any = {};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var valid4: any = _errs15 === errors;if(valid4){const err5: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {errors = _errs14;if(vErrors !== null){if(_errs14){vErrors.length = _errs14;}else {vErrors = null;}}}var valid3: any = _errs13 === errors;}var valid2: any = _errs10 === errors;if(!valid2){const err6: any = {instancePath:instancePath+"/options",schemaPath:"#/properties/options/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;validate1271.errors = vErrors;return false;break;}}if(valid2){for(const key2 in data2){let data3: any = data2[key2];const _errs17: any = errors;if(errors === _errs17){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1271.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1271.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1271.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1271.errors = [{instancePath:instancePath+"/options/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/options/additionalProperties/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;if(!valid5){break;}}}}else {validate1271.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1271.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1271.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1271.errors = null as any[] | null;
// prettier-ignore
validate1271.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1273(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1273.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.marketplace === undefined) && (missing0 = "marketplace"))) || ((data.installed === undefined) && (missing0 = "installed"))) || ((data.installedInTerminal === undefined) && (missing0 = "installedInTerminal"))){validate1273.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "id") || (key0 === "provider")) || (key0 === "name")) || (key0 === "displayName")) || (key0 === "description")) || (key0 === "marketplace")) || (key0 === "installed")) || (key0 === "installedInTerminal"))){validate1273.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1273.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1273.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1273.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1273.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1273.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1273.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1273.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1273.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1273.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1273.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate1273.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1273.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs12: any = errors;if(typeof data.description !== "string"){validate1273.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.marketplace !== undefined){let data5: any = data.marketplace;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 128){validate1273.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1273.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1273.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1273.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.installed !== undefined){const _errs16: any = errors;if(typeof data.installed !== "boolean"){validate1273.errors = [{instancePath:instancePath+"/installed",schemaPath:"#/properties/installed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.installedInTerminal !== undefined){const _errs18: any = errors;if(typeof data.installedInTerminal !== "boolean"){validate1273.errors = [{instancePath:instancePath+"/installedInTerminal",schemaPath:"#/properties/installedInTerminal/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate1273.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1273.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1273.errors = null as any[] | null;
// prettier-ignore
validate1273.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1272(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstallResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1272.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugin === undefined) && (missing0 = "plugin")){validate1272.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "plugin")){validate1272.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugin !== undefined){if(!(validate1273.call(this, data.plugin, {instancePath:instancePath+"/plugin",parentData:data,parentDataProperty:"plugin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1273.errors : vErrors.concat(validate1273.errors);errors = vErrors.length;}}}}}else {validate1272.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1272.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1272.errors = null as any[] | null;
// prettier-ignore
validate1272.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1275(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstalledListRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1275.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "provider")){validate1275.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1275.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1275.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}}}}else {validate1275.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1275.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1275.errors = null as any[] | null;
// prettier-ignore
validate1275.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1276(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginInstalledListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1276.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.plugins === undefined) && (missing0 = "plugins")){validate1276.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "plugins")){validate1276.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.plugins !== undefined){let data0: any = data.plugins;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate1273.call(this, data0[i0], {instancePath:instancePath+"/plugins/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1273.errors : vErrors.concat(validate1273.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1276.errors = [{instancePath:instancePath+"/plugins",schemaPath:"#/properties/plugins/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate1276.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1276.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1276.errors = null as any[] | null;
// prettier-ignore
validate1276.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1278(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceAddRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1278.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.source === undefined) && (missing0 = "source"))){validate1278.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "source"))){validate1278.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1278.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1278.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){let data1: any = data.source;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1278.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1278.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1278.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1278.errors = [{instancePath:instancePath+"/source",schemaPath:"#/properties/source/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1278.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1278.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1278.errors = null as any[] | null;
// prettier-ignore
validate1278.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1279(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceAddResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1279.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.name === undefined) && (missing0 = "name")){validate1279.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "name")){validate1279.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1279.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1279.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1279.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1279.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate1279.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1279.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1279.errors = null as any[] | null;
// prettier-ignore
validate1279.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1280(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceRemoveRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1280.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.name === undefined) && (missing0 = "name"))){validate1280.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "name"))){validate1280.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1280.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1280.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1280.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1280.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1280.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1280.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1280.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1280.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1280.errors = null as any[] | null;
// prettier-ignore
validate1280.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1281(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginMarketplaceRemoveResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1281.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.removed === undefined) && (missing0 = "removed")){validate1281.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "removed")){validate1281.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.removed !== undefined){let data0: any = data.removed;if(typeof data0 !== "boolean"){validate1281.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1281.errors = [{instancePath:instancePath+"/removed",schemaPath:"#/properties/removed/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1281.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1281.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1281.errors = null as any[] | null;
// prettier-ignore
validate1281.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2398: any = {"type":"object","additionalProperties":false,"properties":{"name":{"type":"string","minLength":1,"description":"Its name."},"description":{"type":["string","null"],"description":"Its description, or `null`."}},"required":["name","description"],"description":"One item a plugin carries. A hook is named by its event, which the view puts in plain words;\n`description` is `null` where the item has none."};
// prettier-ignore
function validate1283(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1283.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.agents === undefined) && (missing0 = "agents")) || ((data.skills === undefined) && (missing0 = "skills"))) || ((data.mcpServers === undefined) && (missing0 = "mcpServers"))) || ((data.hooks === undefined) && (missing0 = "hooks"))){validate1283.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "agents") || (key0 === "skills")) || (key0 === "mcpServers")) || (key0 === "hooks"))){validate1283.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.agents !== undefined){let data0: any = data.agents;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){let data1: any = data0[i0];const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if(((data1.name === undefined) && (missing1 = "name")) || ((data1.description === undefined) && (missing1 = "description"))){validate1283.errors = [{instancePath:instancePath+"/agents/" + i0,schemaPath:"#/$defs/PluginItem/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs7: any = errors;for(const key1 in data1){if(!((key1 === "name") || (key1 === "description"))){validate1283.errors = [{instancePath:instancePath+"/agents/" + i0,schemaPath:"#/$defs/PluginItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs7 === errors){if(data1.name !== undefined){let data2: any = data1.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) < 1){validate1283.errors = [{instancePath:instancePath+"/agents/" + i0+"/name",schemaPath:"#/$defs/PluginItem/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1283.errors = [{instancePath:instancePath+"/agents/" + i0+"/name",schemaPath:"#/$defs/PluginItem/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs8 === errors;}else {var valid3: any = true;}if(valid3){if(data1.description !== undefined){let data3: any = data1.description;const _errs10: any = errors;if((typeof data3 !== "string") && (data3 !== null)){validate1283.errors = [{instancePath:instancePath+"/agents/" + i0+"/description",schemaPath:"#/$defs/PluginItem/properties/description/type",keyword:"type",params:{type: schema2398.properties.description.type}}];return false;}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}}}}}else {validate1283.errors = [{instancePath:instancePath+"/agents/" + i0,schemaPath:"#/$defs/PluginItem/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate1283.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.skills !== undefined){let data4: any = data.skills;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data4)){var valid4: any = true;const len1: any = data4.length;for(let i1=0; i1<len1; i1++){let data5: any = data4[i1];const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing2: any;if(((data5.name === undefined) && (missing2 = "name")) || ((data5.description === undefined) && (missing2 = "description"))){validate1283.errors = [{instancePath:instancePath+"/skills/" + i1,schemaPath:"#/$defs/PluginItem/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs17: any = errors;for(const key2 in data5){if(!((key2 === "name") || (key2 === "description"))){validate1283.errors = [{instancePath:instancePath+"/skills/" + i1,schemaPath:"#/$defs/PluginItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs17 === errors){if(data5.name !== undefined){let data6: any = data5.name;const _errs18: any = errors;if(errors === _errs18){if(typeof data6 === "string"){if(func1(data6) < 1){validate1283.errors = [{instancePath:instancePath+"/skills/" + i1+"/name",schemaPath:"#/$defs/PluginItem/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1283.errors = [{instancePath:instancePath+"/skills/" + i1+"/name",schemaPath:"#/$defs/PluginItem/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs18 === errors;}else {var valid6: any = true;}if(valid6){if(data5.description !== undefined){let data7: any = data5.description;const _errs20: any = errors;if((typeof data7 !== "string") && (data7 !== null)){validate1283.errors = [{instancePath:instancePath+"/skills/" + i1+"/description",schemaPath:"#/$defs/PluginItem/properties/description/type",keyword:"type",params:{type: schema2398.properties.description.type}}];return false;}var valid6: any = _errs20 === errors;}else {var valid6: any = true;}}}}}else {validate1283.errors = [{instancePath:instancePath+"/skills/" + i1,schemaPath:"#/$defs/PluginItem/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs14 === errors;if(!valid4){break;}}}else {validate1283.errors = [{instancePath:instancePath+"/skills",schemaPath:"#/properties/skills/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.mcpServers !== undefined){let data8: any = data.mcpServers;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data8)){var valid7: any = true;const len2: any = data8.length;for(let i2=0; i2<len2; i2++){let data9: any = data8[i2];const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){let missing3: any;if(((data9.name === undefined) && (missing3 = "name")) || ((data9.description === undefined) && (missing3 = "description"))){validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2,schemaPath:"#/$defs/PluginItem/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs27: any = errors;for(const key3 in data9){if(!((key3 === "name") || (key3 === "description"))){validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2,schemaPath:"#/$defs/PluginItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data9.name !== undefined){let data10: any = data9.name;const _errs28: any = errors;if(errors === _errs28){if(typeof data10 === "string"){if(func1(data10) < 1){validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2+"/name",schemaPath:"#/$defs/PluginItem/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2+"/name",schemaPath:"#/$defs/PluginItem/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs28 === errors;}else {var valid9: any = true;}if(valid9){if(data9.description !== undefined){let data11: any = data9.description;const _errs30: any = errors;if((typeof data11 !== "string") && (data11 !== null)){validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2+"/description",schemaPath:"#/$defs/PluginItem/properties/description/type",keyword:"type",params:{type: schema2398.properties.description.type}}];return false;}var valid9: any = _errs30 === errors;}else {var valid9: any = true;}}}}}else {validate1283.errors = [{instancePath:instancePath+"/mcpServers/" + i2,schemaPath:"#/$defs/PluginItem/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs24 === errors;if(!valid7){break;}}}else {validate1283.errors = [{instancePath:instancePath+"/mcpServers",schemaPath:"#/properties/mcpServers/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.hooks !== undefined){let data12: any = data.hooks;const _errs32: any = errors;if(errors === _errs32){if(Array.isArray(data12)){var valid10: any = true;const len3: any = data12.length;for(let i3=0; i3<len3; i3++){let data13: any = data12[i3];const _errs34: any = errors;const _errs35: any = errors;if(errors === _errs35){if(data13 && typeof data13 == "object" && !Array.isArray(data13)){let missing4: any;if(((data13.name === undefined) && (missing4 = "name")) || ((data13.description === undefined) && (missing4 = "description"))){validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3,schemaPath:"#/$defs/PluginItem/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs37: any = errors;for(const key4 in data13){if(!((key4 === "name") || (key4 === "description"))){validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3,schemaPath:"#/$defs/PluginItem/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs37 === errors){if(data13.name !== undefined){let data14: any = data13.name;const _errs38: any = errors;if(errors === _errs38){if(typeof data14 === "string"){if(func1(data14) < 1){validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3+"/name",schemaPath:"#/$defs/PluginItem/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3+"/name",schemaPath:"#/$defs/PluginItem/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs38 === errors;}else {var valid12: any = true;}if(valid12){if(data13.description !== undefined){let data15: any = data13.description;const _errs40: any = errors;if((typeof data15 !== "string") && (data15 !== null)){validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3+"/description",schemaPath:"#/$defs/PluginItem/properties/description/type",keyword:"type",params:{type: schema2398.properties.description.type}}];return false;}var valid12: any = _errs40 === errors;}else {var valid12: any = true;}}}}}else {validate1283.errors = [{instancePath:instancePath+"/hooks/" + i3,schemaPath:"#/$defs/PluginItem/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs34 === errors;if(!valid10){break;}}}else {validate1283.errors = [{instancePath:instancePath+"/hooks",schemaPath:"#/properties/hooks/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs32 === errors;}else {var valid0: any = true;}}}}}}}else {validate1283.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1283.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1283.errors = null as any[] | null;
// prettier-ignore
validate1283.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1282(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1282.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.items === undefined) && (missing0 = "items")) || ((data.source === undefined) && (missing0 = "source"))){validate1282.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "items") || (key0 === "source"))){validate1282.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.items !== undefined){const _errs2: any = errors;if(!(validate1283.call(this, data.items, {instancePath:instancePath+"/items",parentData:data,parentDataProperty:"items",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1283.errors : vErrors.concat(validate1283.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){let data1: any = data.source;const _errs3: any = errors;const _errs4: any = errors;if(errors === _errs4){if(data1 && typeof data1 == "object" && !Array.isArray(data1)){let missing1: any;if((data1.marketplace === undefined) && (missing1 = "marketplace")){validate1282.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/PluginSource/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs6: any = errors;for(const key1 in data1){if(!(((key1 === "marketplace") || (key1 === "repository")) || (key1 === "commit"))){validate1282.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/PluginSource/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs6 === errors){if(data1.marketplace !== undefined){let data2: any = data1.marketplace;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) > 128){validate1282.errors = [{instancePath:instancePath+"/source/marketplace",schemaPath:"#/$defs/PluginSource/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1282.errors = [{instancePath:instancePath+"/source/marketplace",schemaPath:"#/$defs/PluginSource/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1282.errors = [{instancePath:instancePath+"/source/marketplace",schemaPath:"#/$defs/PluginSource/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1282.errors = [{instancePath:instancePath+"/source/marketplace",schemaPath:"#/$defs/PluginSource/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data1.repository !== undefined){let data3: any = data1.repository;const _errs9: any = errors;if(errors === _errs9){if(typeof data3 === "string"){if(func1(data3) > 4096){validate1282.errors = [{instancePath:instancePath+"/source/repository",schemaPath:"#/$defs/PluginSource/properties/repository/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data3) < 1){validate1282.errors = [{instancePath:instancePath+"/source/repository",schemaPath:"#/$defs/PluginSource/properties/repository/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1282.errors = [{instancePath:instancePath+"/source/repository",schemaPath:"#/$defs/PluginSource/properties/repository/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1282.errors = [{instancePath:instancePath+"/source/repository",schemaPath:"#/$defs/PluginSource/properties/repository/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data1.commit !== undefined){let data4: any = data1.commit;const _errs11: any = errors;if(errors === _errs11){if(typeof data4 === "string"){if(func1(data4) > 128){validate1282.errors = [{instancePath:instancePath+"/source/commit",schemaPath:"#/$defs/PluginSource/properties/commit/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate1282.errors = [{instancePath:instancePath+"/source/commit",schemaPath:"#/$defs/PluginSource/properties/commit/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1282.errors = [{instancePath:instancePath+"/source/commit",schemaPath:"#/$defs/PluginSource/properties/commit/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1282.errors = [{instancePath:instancePath+"/source/commit",schemaPath:"#/$defs/PluginSource/properties/commit/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){let missing2: any;if(data1.repository !== undefined && ((data1.commit === undefined) && (missing2 = "commit"))){validate1282.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/PluginSource/dependentRequired",keyword:"dependentRequired",params:{property: "repository",
    missingProperty: missing2,
    depsCount: 1,
    deps: "commit"}}];return false;}else {if(data1.commit !== undefined && ((data1.repository === undefined) && (missing2 = "repository"))){validate1282.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/PluginSource/dependentRequired",keyword:"dependentRequired",params:{property: "commit",
    missingProperty: missing2,
    depsCount: 1,
    deps: "repository"}}];return false;}}}}}}}}else {validate1282.errors = [{instancePath:instancePath+"/source",schemaPath:"#/$defs/PluginSource/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate1282.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1282.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1282.errors = null as any[] | null;
// prettier-ignore
validate1282.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1285(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginRef {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1285.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.id === undefined) && (missing0 = "id"))){validate1285.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "provider") || (key0 === "id"))){validate1285.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1285.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1285.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.id !== undefined){let data1: any = data.id;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1285.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1285.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1285.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1285.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1285.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1285.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1285.errors = null as any[] | null;
// prettier-ignore
validate1285.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1286(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1286.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.marketplace === undefined) && (missing0 = "marketplace")){validate1286.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "marketplace") || (key0 === "repository")) || (key0 === "commit"))){validate1286.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.marketplace !== undefined){let data0: any = data.marketplace;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1286.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1286.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1286.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1286.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repository !== undefined){let data1: any = data.repository;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1286.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1286.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1286.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1286.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.commit !== undefined){let data2: any = data.commit;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 128){validate1286.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1286.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1286.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1286.errors = [{instancePath:instancePath+"/commit",schemaPath:"#/properties/commit/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.repository !== undefined && ((data.commit === undefined) && (missing1 = "commit"))){validate1286.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "repository",
    missingProperty: missing1,
    depsCount: 1,
    deps: "commit"}}];return false;}else {if(data.commit !== undefined && ((data.repository === undefined) && (missing1 = "repository"))){validate1286.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "commit",
    missingProperty: missing1,
    depsCount: 1,
    deps: "repository"}}];return false;}}}}}}}}else {validate1286.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1286.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1286.errors = null as any[] | null;
// prettier-ignore
validate1286.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1287(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginSummary {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1287.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.marketplace === undefined) && (missing0 = "marketplace"))) || ((data.installed === undefined) && (missing0 = "installed"))) || ((data.installedInTerminal === undefined) && (missing0 = "installedInTerminal"))){validate1287.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "id") || (key0 === "provider")) || (key0 === "name")) || (key0 === "displayName")) || (key0 === "description")) || (key0 === "marketplace")) || (key0 === "installed")) || (key0 === "installedInTerminal"))){validate1287.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1287.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1287.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1287.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1287.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1287.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1287.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1287.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1287.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1287.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1287.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate1287.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate1287.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs12: any = errors;if(typeof data.description !== "string"){validate1287.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.marketplace !== undefined){let data5: any = data.marketplace;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) > 128){validate1287.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1287.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1287.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1287.errors = [{instancePath:instancePath+"/marketplace",schemaPath:"#/properties/marketplace/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.installed !== undefined){const _errs16: any = errors;if(typeof data.installed !== "boolean"){validate1287.errors = [{instancePath:instancePath+"/installed",schemaPath:"#/properties/installed/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.installedInTerminal !== undefined){const _errs18: any = errors;if(typeof data.installedInTerminal !== "boolean"){validate1287.errors = [{instancePath:instancePath+"/installedInTerminal",schemaPath:"#/properties/installedInTerminal/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate1287.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1287.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1287.errors = null as any[] | null;
// prettier-ignore
validate1287.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1288(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is PluginUninstallResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1288.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.uninstalled === undefined) && (missing0 = "uninstalled")){validate1288.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "uninstalled")){validate1288.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.uninstalled !== undefined){let data0: any = data.uninstalled;if(typeof data0 !== "boolean"){validate1288.errors = [{instancePath:instancePath+"/uninstalled",schemaPath:"#/properties/uninstalled/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate1288.errors = [{instancePath:instancePath+"/uninstalled",schemaPath:"#/properties/uninstalled/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate1288.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1288.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1288.errors = null as any[] | null;
// prettier-ignore
validate1288.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link PluginAppListRequest}. */
export const validatePluginAppListRequest: SchemaCheck<PluginAppListRequest> = validate1261;
/** Checks that a value is a {@link PluginAppListResponse}. */
export const validatePluginAppListResponse: SchemaCheck<PluginAppListResponse> = validate1262;
/** Checks that a value is a {@link PluginCatalogListRequest}. */
export const validatePluginCatalogListRequest: SchemaCheck<PluginCatalogListRequest> = validate1267;
/** Checks that a value is a {@link PluginCatalogListResponse}. */
export const validatePluginCatalogListResponse: SchemaCheck<PluginCatalogListResponse> =
  validate1268;
/** Checks that a value is a {@link PluginInstallRequest}. */
export const validatePluginInstallRequest: SchemaCheck<PluginInstallRequest> = validate1271;
/** Checks that a value is a {@link PluginInstallResponse}. */
export const validatePluginInstallResponse: SchemaCheck<PluginInstallResponse> = validate1272;
/** Checks that a value is a {@link PluginInstalledListRequest}. */
export const validatePluginInstalledListRequest: SchemaCheck<PluginInstalledListRequest> =
  validate1275;
/** Checks that a value is a {@link PluginInstalledListResponse}. */
export const validatePluginInstalledListResponse: SchemaCheck<PluginInstalledListResponse> =
  validate1276;
/** Checks that a value is a {@link PluginMarketplaceAddRequest}. */
export const validatePluginMarketplaceAddRequest: SchemaCheck<PluginMarketplaceAddRequest> =
  validate1278;
/** Checks that a value is a {@link PluginMarketplaceAddResponse}. */
export const validatePluginMarketplaceAddResponse: SchemaCheck<PluginMarketplaceAddResponse> =
  validate1279;
/** Checks that a value is a {@link PluginMarketplaceRemoveRequest}. */
export const validatePluginMarketplaceRemoveRequest: SchemaCheck<PluginMarketplaceRemoveRequest> =
  validate1280;
/** Checks that a value is a {@link PluginMarketplaceRemoveResponse}. */
export const validatePluginMarketplaceRemoveResponse: SchemaCheck<PluginMarketplaceRemoveResponse> =
  validate1281;
/** Checks that a value is a {@link PluginReadResponse}. */
export const validatePluginReadResponse: SchemaCheck<PluginReadResponse> = validate1282;
/** Checks that a value is a {@link PluginRef}. */
export const validatePluginRef: SchemaCheck<PluginRef> = validate1285;
/** Checks that a value is a {@link PluginSource}. */
export const validatePluginSource: SchemaCheck<PluginSource> = validate1286;
/** Checks that a value is a {@link PluginSummary}. */
export const validatePluginSummary: SchemaCheck<PluginSummary> = validate1287;
/** Checks that a value is a {@link PluginUninstallResponse}. */
export const validatePluginUninstallResponse: SchemaCheck<PluginUninstallResponse> = validate1288;

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
