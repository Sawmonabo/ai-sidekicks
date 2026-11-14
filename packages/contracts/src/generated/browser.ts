// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The machine-wide browser methods behind Settings › Browser.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../schema-check.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";

/**
 * A site's origin: an http(s) origin, scheme://host[:port].
 */
export type SiteOrigin = string;
/**
 * An installed Chromium that runs pages: the desktop app's own, or an installed Chrome or Edge.
 */
export type BrowserInstalledChromiumSource = "desktop" | "chrome" | "edge";
/**
 * Why the daemon's headless Chromium cannot start on this machine.
 */
export type BrowserChromiumCannotStartReason = "missingSystemLibraries";
/**
 * The Chromium in use, its version, and when it was fetched; `fetchedAt` is set exactly when the
 * source is the fetched one.
 */
export type BrowserChromiumReadResponse =
  | {
      /**
       * The fetched Chromium.
       */
      source: "chromeForTesting";
      /**
       * When it was fetched.
       */
      fetchedAt: WireInstant;
      /**
       * Its version.
       */
      version: string;
      /**
       * Why the headless Chromium cannot start here, or `null`.
       */
      cannotStart: BrowserChromiumCannotStart | null;
    }
  | {
      /**
       * Which one.
       */
      source: BrowserInstalledChromiumSource;
      /**
       * Always `null`: only a fetched Chromium has a fetch time.
       */
      fetchedAt: null;
      /**
       * Its version.
       */
      version: string;
      /**
       * Why the headless Chromium cannot start here, or `null`.
       */
      cannotStart: BrowserChromiumCannotStart | null;
    };

/**
 * One site holding saved data. `hasCookies` is true while it holds at least one unexpired cookie,
 * and the row then reads `Saved cookies`; otherwise it holds other saved data and reads `Saved
 * site data`. Nothing here says whether the person is signed in, because a cookie does not prove
 * a login.
 */
export interface BrowserSiteData {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * How much it saved, in bytes.
   */
  sizeBytes: number;
  /**
   * When it was last used.
   */
  lastUsedAt: WireInstant;
  /**
   * Whether it holds an unexpired cookie.
   */
  hasCookies: boolean;
}
/**
 * Every site with saved data, one per registrable domain.
 */
export interface BrowserSiteDataListResponse {
  /**
   * The sites.
   */
  sites: BrowserSiteData[];
}
/**
 * Names one site: sign in to it, clear its cookies, or forget it.
 */
export interface BrowserSiteRequest {
  /**
   * The site.
   */
  origin: SiteOrigin;
}
/**
 * The site opened in a page of its own that belongs to no session, over the machine's site data,
 * showing the address line and nothing else. What the site saves there is kept for every browser.
 */
export interface BrowserSiteSignInResponse {
  /**
   * Always true.
   */
  opened: true;
}
/**
 * The site's cookies are gone across its registrable domain, and nothing else: its storage, cache
 * and service workers stay. It claims nothing about signing out.
 */
export interface BrowserCookieClearResponse {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * Always true.
   */
  cleared: true;
}
/**
 * Every kind of data the site saved is gone; a site holding nothing answers the same.
 */
export interface BrowserSiteDataForgetResponse {
  /**
   * The site.
   */
  origin: SiteOrigin;
  /**
   * Always true.
   */
  forgotten: true;
}
/**
 * Every site's saved data is gone.
 */
export interface BrowserSiteDataClearResponse {
  /**
   * Always true.
   */
  cleared: true;
}
/**
 * The headless Chromium cannot start. `installStep` is the command that installs what it needs
 * for the version the service carries, shown as text and never run, because it needs an
 * administrator.
 */
export interface BrowserChromiumCannotStart {
  /**
   * Why.
   */
  reason: BrowserChromiumCannotStartReason;
  /**
   * The command that fixes it.
   */
  installStep: string;
}
/**
 * The fetch started; its progress is a flow row. A fetch asked for during one joins it.
 */
export interface BrowserChromiumFetchResponse {
  /**
   * Always true.
   */
  started: true;
}

// prettier-ignore
const formats2 = SCHEMA_FORMATS["site-origin"];
/** Checks that a value is a {@link SiteOrigin}. */
// prettier-ignore
export const validateSiteOrigin: CompiledSchemaCheck<SiteOrigin> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SiteOrigin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSiteOrigin.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(errors === 0){if(typeof data === "string"){if(!(formats2(data))){validateSiteOrigin.errors = [{instancePath,schemaPath:"#/format",keyword:"format",params:{format: "site-origin"}}];return false;}}else {validateSiteOrigin.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}}validateSiteOrigin.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSiteOrigin.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteData}. */
// prettier-ignore
export const validateBrowserSiteData: CompiledSchemaCheck<BrowserSiteData> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteData {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteData.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.origin === undefined) && (missing0 = "origin")) || ((data.sizeBytes === undefined) && (missing0 = "sizeBytes"))) || ((data.lastUsedAt === undefined) && (missing0 = "lastUsedAt"))) || ((data.hasCookies === undefined) && (missing0 = "hasCookies"))){validateBrowserSiteData.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "origin") || (key0 === "sizeBytes")) || (key0 === "lastUsedAt")) || (key0 === "hasCookies"))){validateBrowserSiteData.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origin !== undefined){const _errs2: any = errors;if(!(validateSiteOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSiteOrigin.errors : vErrors.concat(validateSiteOrigin.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sizeBytes !== undefined){let data1: any = data.sizeBytes;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateBrowserSiteData.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateBrowserSiteData.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateBrowserSiteData.errors = [{instancePath:instancePath+"/sizeBytes",schemaPath:"#/properties/sizeBytes/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastUsedAt !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.lastUsedAt, {instancePath:instancePath+"/lastUsedAt",parentData:data,parentDataProperty:"lastUsedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.hasCookies !== undefined){const _errs6: any = errors;if(typeof data.hasCookies !== "boolean"){validateBrowserSiteData.errors = [{instancePath:instancePath+"/hasCookies",schemaPath:"#/properties/hasCookies/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateBrowserSiteData.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteData.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteData.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteDataListResponse}. */
// prettier-ignore
export const validateBrowserSiteDataListResponse: CompiledSchemaCheck<BrowserSiteDataListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteDataListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteDataListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sites === undefined) && (missing0 = "sites")){validateBrowserSiteDataListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "sites")){validateBrowserSiteDataListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sites !== undefined){let data0: any = data.sites;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateBrowserSiteData.call(this, data0[i0], {instancePath:instancePath+"/sites/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBrowserSiteData.errors : vErrors.concat(validateBrowserSiteData.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateBrowserSiteDataListResponse.errors = [{instancePath:instancePath+"/sites",schemaPath:"#/properties/sites/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateBrowserSiteDataListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteDataListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteDataListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteRequest}. */
// prettier-ignore
export const validateBrowserSiteRequest: CompiledSchemaCheck<BrowserSiteRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.origin === undefined) && (missing0 = "origin")){validateBrowserSiteRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "origin")){validateBrowserSiteRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origin !== undefined){if(!(validateSiteOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSiteOrigin.errors : vErrors.concat(validateSiteOrigin.errors);errors = vErrors.length;}}}}}else {validateBrowserSiteRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteSignInResponse}. */
// prettier-ignore
export const validateBrowserSiteSignInResponse: CompiledSchemaCheck<BrowserSiteSignInResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteSignInResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteSignInResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.opened === undefined) && (missing0 = "opened")){validateBrowserSiteSignInResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "opened")){validateBrowserSiteSignInResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.opened !== undefined){let data0: any = data.opened;if(typeof data0 !== "boolean"){validateBrowserSiteSignInResponse.errors = [{instancePath:instancePath+"/opened",schemaPath:"#/properties/opened/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateBrowserSiteSignInResponse.errors = [{instancePath:instancePath+"/opened",schemaPath:"#/properties/opened/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validateBrowserSiteSignInResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteSignInResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteSignInResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserCookieClearResponse}. */
// prettier-ignore
export const validateBrowserCookieClearResponse: CompiledSchemaCheck<BrowserCookieClearResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserCookieClearResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserCookieClearResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.origin === undefined) && (missing0 = "origin")) || ((data.cleared === undefined) && (missing0 = "cleared"))){validateBrowserCookieClearResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "origin") || (key0 === "cleared"))){validateBrowserCookieClearResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origin !== undefined){const _errs2: any = errors;if(!(validateSiteOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSiteOrigin.errors : vErrors.concat(validateSiteOrigin.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.cleared !== undefined){let data1: any = data.cleared;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateBrowserCookieClearResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateBrowserCookieClearResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateBrowserCookieClearResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserCookieClearResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserCookieClearResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteDataForgetResponse}. */
// prettier-ignore
export const validateBrowserSiteDataForgetResponse: CompiledSchemaCheck<BrowserSiteDataForgetResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteDataForgetResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteDataForgetResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.origin === undefined) && (missing0 = "origin")) || ((data.forgotten === undefined) && (missing0 = "forgotten"))){validateBrowserSiteDataForgetResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "origin") || (key0 === "forgotten"))){validateBrowserSiteDataForgetResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.origin !== undefined){const _errs2: any = errors;if(!(validateSiteOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSiteOrigin.errors : vErrors.concat(validateSiteOrigin.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.forgotten !== undefined){let data1: any = data.forgotten;const _errs3: any = errors;if(typeof data1 !== "boolean"){validateBrowserSiteDataForgetResponse.errors = [{instancePath:instancePath+"/forgotten",schemaPath:"#/properties/forgotten/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data1){validateBrowserSiteDataForgetResponse.errors = [{instancePath:instancePath+"/forgotten",schemaPath:"#/properties/forgotten/const",keyword:"const",params:{allowedValue: true}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateBrowserSiteDataForgetResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteDataForgetResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteDataForgetResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserSiteDataClearResponse}. */
// prettier-ignore
export const validateBrowserSiteDataClearResponse: CompiledSchemaCheck<BrowserSiteDataClearResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserSiteDataClearResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserSiteDataClearResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cleared === undefined) && (missing0 = "cleared")){validateBrowserSiteDataClearResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cleared")){validateBrowserSiteDataClearResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cleared !== undefined){let data0: any = data.cleared;if(typeof data0 !== "boolean"){validateBrowserSiteDataClearResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateBrowserSiteDataClearResponse.errors = [{instancePath:instancePath+"/cleared",schemaPath:"#/properties/cleared/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validateBrowserSiteDataClearResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserSiteDataClearResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserSiteDataClearResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema179: any = {"description":"An installed Chromium that runs pages: the desktop app's own, or an installed Chrome or Edge.","type":"string","enum":["desktop","chrome","edge"]};
/** Checks that a value is a {@link BrowserInstalledChromiumSource}. */
// prettier-ignore
export const validateBrowserInstalledChromiumSource: CompiledSchemaCheck<BrowserInstalledChromiumSource> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserInstalledChromiumSource {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserInstalledChromiumSource.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateBrowserInstalledChromiumSource.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "desktop") || (data === "chrome")) || (data === "edge"))){validateBrowserInstalledChromiumSource.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema179.enum}}];return false;}validateBrowserInstalledChromiumSource.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserInstalledChromiumSource.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema178: any = {"description":"Why the daemon's headless Chromium cannot start on this machine.","type":"string","enum":["missingSystemLibraries"]};
/** Checks that a value is a {@link BrowserChromiumCannotStartReason}. */
// prettier-ignore
export const validateBrowserChromiumCannotStartReason: CompiledSchemaCheck<BrowserChromiumCannotStartReason> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserChromiumCannotStartReason {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserChromiumCannotStartReason.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateBrowserChromiumCannotStartReason.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "missingSystemLibraries")){validateBrowserChromiumCannotStartReason.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema178.enum}}];return false;}validateBrowserChromiumCannotStartReason.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserChromiumCannotStartReason.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link BrowserChromiumCannotStart}. */
// prettier-ignore
export const validateBrowserChromiumCannotStart: CompiledSchemaCheck<BrowserChromiumCannotStart> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserChromiumCannotStart {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserChromiumCannotStart.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.reason === undefined) && (missing0 = "reason")) || ((data.installStep === undefined) && (missing0 = "installStep"))){validateBrowserChromiumCannotStart.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "reason") || (key0 === "installStep"))){validateBrowserChromiumCannotStart.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.reason !== undefined){const _errs2: any = errors;if(!(validateBrowserChromiumCannotStartReason.call(this, data.reason, {instancePath:instancePath+"/reason",parentData:data,parentDataProperty:"reason",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBrowserChromiumCannotStartReason.errors : vErrors.concat(validateBrowserChromiumCannotStartReason.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.installStep !== undefined){let data1: any = data.installStep;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateBrowserChromiumCannotStart.errors = [{instancePath:instancePath+"/installStep",schemaPath:"#/properties/installStep/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateBrowserChromiumCannotStart.errors = [{instancePath:instancePath+"/installStep",schemaPath:"#/properties/installStep/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateBrowserChromiumCannotStart.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserChromiumCannotStart.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserChromiumCannotStart.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema176: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"source":{"description":"The fetched Chromium.","type":"string","enum":["chromeForTesting"]},"fetchedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it was fetched."},"version":{"type":"string","minLength":1,"description":"Its version."},"cannotStart":{"anyOf":[{"$ref":"#/$defs/BrowserChromiumCannotStart"},{"type":"null"}],"description":"Why the headless Chromium cannot start here, or `null`."}},"required":["source","fetchedAt","version","cannotStart"],"description":"The fetched Chromium."},{"type":"object","additionalProperties":false,"properties":{"source":{"$ref":"#/$defs/BrowserInstalledChromiumSource","description":"Which one."},"fetchedAt":{"anyOf":[{"not":{},"tsType":"never"},{"type":"null"}],"description":"Always `null`: only a fetched Chromium has a fetch time."},"version":{"type":"string","minLength":1,"description":"Its version."},"cannotStart":{"anyOf":[{"$ref":"#/$defs/BrowserChromiumCannotStart"},{"type":"null"}],"description":"Why the headless Chromium cannot start here, or `null`."}},"required":["source","fetchedAt","version","cannotStart"],"description":"An installed Chromium."}],"description":"The Chromium in use, its version, and when it was fetched; `fetchedAt` is set exactly when the\nsource is the fetched one."};
/** Checks that a value is a {@link BrowserChromiumReadResponse}. */
// prettier-ignore
export const validateBrowserChromiumReadResponse: CompiledSchemaCheck<BrowserChromiumReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserChromiumReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserChromiumReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.source === undefined) && (missing0 = "source")) || ((data.fetchedAt === undefined) && (missing0 = "fetchedAt"))) || ((data.version === undefined) && (missing0 = "version"))) || ((data.cannotStart === undefined) && (missing0 = "cannotStart"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "source") || (key0 === "fetchedAt")) || (key0 === "version")) || (key0 === "cannotStart"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.source !== undefined){let data0: any = data.source;const _errs4: any = errors;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/source",schemaPath:"#/anyOf/0/properties/source/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data0 === "chromeForTesting")){const err3: any = {instancePath:instancePath+"/source",schemaPath:"#/anyOf/0/properties/source/enum",keyword:"enum",params:{allowedValues: schema176.anyOf[0].properties.source.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.fetchedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.fetchedAt, {instancePath:instancePath+"/fetchedAt",parentData:data,parentDataProperty:"fetchedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.version !== undefined){let data2: any = data.version;const _errs7: any = errors;if(errors === _errs7){if(typeof data2 === "string"){if(func1(data2) < 1){const err4: any = {instancePath:instancePath+"/version",schemaPath:"#/anyOf/0/properties/version/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/version",schemaPath:"#/anyOf/0/properties/version/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.cannotStart !== undefined){let data3: any = data.cannotStart;const _errs9: any = errors;const _errs10: any = errors;let valid2: any = false;const _errs11: any = errors;if(!(validateBrowserChromiumCannotStart.call(this, data3, {instancePath:instancePath+"/cannotStart",parentData:data,parentDataProperty:"cannotStart",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBrowserChromiumCannotStart.errors : vErrors.concat(validateBrowserChromiumCannotStart.errors);errors = vErrors.length;}var _valid1: any = _errs11 === errors;valid2 = valid2 || _valid1;const _errs12: any = errors;if(data3 !== null){const err6: any = {instancePath:instancePath+"/cannotStart",schemaPath:"#/anyOf/0/properties/cannotStart/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}var _valid1: any = _errs12 === errors;valid2 = valid2 || _valid1;if(!valid2){const err7: any = {instancePath:instancePath+"/cannotStart",schemaPath:"#/anyOf/0/properties/cannotStart/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {errors = _errs10;if(vErrors !== null){if(_errs10){vErrors.length = _errs10;}else {vErrors = null;}}}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}}}}}}}else {const err8: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props1: any = true;}const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.source === undefined) && (missing1 = "source")) || ((data.fetchedAt === undefined) && (missing1 = "fetchedAt"))) || ((data.version === undefined) && (missing1 = "version"))) || ((data.cannotStart === undefined) && (missing1 = "cannotStart"))){const err9: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}else {const _errs16: any = errors;for(const key1 in data){if(!((((key1 === "source") || (key1 === "fetchedAt")) || (key1 === "version")) || (key1 === "cannotStart"))){const err10: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;break;}}if(_errs16 === errors){if(data.source !== undefined){const _errs17: any = errors;if(!(validateBrowserInstalledChromiumSource.call(this, data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBrowserInstalledChromiumSource.errors : vErrors.concat(validateBrowserInstalledChromiumSource.errors);errors = vErrors.length;}var valid3: any = _errs17 === errors;}else {var valid3: any = true;}if(valid3){if(data.fetchedAt !== undefined){const _errs18: any = errors;const _errs19: any = errors;let valid4: any = false;const _errs20: any = errors;const err11: any = {instancePath:instancePath+"/fetchedAt",schemaPath:"#/anyOf/1/properties/fetchedAt/anyOf/0/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;var _valid2: any = _errs20 === errors;valid4 = valid4 || _valid2;const _errs23: any = errors;if(data.fetchedAt !== null){const err12: any = {instancePath:instancePath+"/fetchedAt",schemaPath:"#/anyOf/1/properties/fetchedAt/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}var _valid2: any = _errs23 === errors;valid4 = valid4 || _valid2;if(!valid4){const err13: any = {instancePath:instancePath+"/fetchedAt",schemaPath:"#/anyOf/1/properties/fetchedAt/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}if(valid3){if(data.version !== undefined){let data6: any = data.version;const _errs25: any = errors;if(errors === _errs25){if(typeof data6 === "string"){if(func1(data6) < 1){const err14: any = {instancePath:instancePath+"/version",schemaPath:"#/anyOf/1/properties/version/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}else {const err15: any = {instancePath:instancePath+"/version",schemaPath:"#/anyOf/1/properties/version/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var valid3: any = _errs25 === errors;}else {var valid3: any = true;}if(valid3){if(data.cannotStart !== undefined){let data7: any = data.cannotStart;const _errs27: any = errors;const _errs28: any = errors;let valid5: any = false;const _errs29: any = errors;if(!(validateBrowserChromiumCannotStart.call(this, data7, {instancePath:instancePath+"/cannotStart",parentData:data,parentDataProperty:"cannotStart",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateBrowserChromiumCannotStart.errors : vErrors.concat(validateBrowserChromiumCannotStart.errors);errors = vErrors.length;}var _valid3: any = _errs29 === errors;valid5 = valid5 || _valid3;const _errs30: any = errors;if(data7 !== null){const err16: any = {instancePath:instancePath+"/cannotStart",schemaPath:"#/anyOf/1/properties/cannotStart/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}var _valid3: any = _errs30 === errors;valid5 = valid5 || _valid3;if(!valid5){const err17: any = {instancePath:instancePath+"/cannotStart",schemaPath:"#/anyOf/1/properties/cannotStart/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}else {errors = _errs28;if(vErrors !== null){if(_errs28){vErrors.length = _errs28;}else {vErrors = null;}}}var valid3: any = _errs27 === errors;}else {var valid3: any = true;}}}}}}}else {const err18: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var _valid0: any = _errs14 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props1 !== true){props1 = true;}}if(!valid0){const err19: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;validateBrowserChromiumReadResponse.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateBrowserChromiumReadResponse.errors = vErrors;evaluated0.props = props1;return errors === 0;};
// prettier-ignore
validateBrowserChromiumReadResponse.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link BrowserChromiumFetchResponse}. */
// prettier-ignore
export const validateBrowserChromiumFetchResponse: CompiledSchemaCheck<BrowserChromiumFetchResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is BrowserChromiumFetchResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateBrowserChromiumFetchResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.started === undefined) && (missing0 = "started")){validateBrowserChromiumFetchResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "started")){validateBrowserChromiumFetchResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.started !== undefined){let data0: any = data.started;if(typeof data0 !== "boolean"){validateBrowserChromiumFetchResponse.errors = [{instancePath:instancePath+"/started",schemaPath:"#/properties/started/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validateBrowserChromiumFetchResponse.errors = [{instancePath:instancePath+"/started",schemaPath:"#/properties/started/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validateBrowserChromiumFetchResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateBrowserChromiumFetchResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateBrowserChromiumFetchResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link BROWSER_METHOD_DESCRIPTORS}, each with its checks. */
export interface BrowserMethodDescriptors {
  readonly "browser.siteData.list": {
    readonly method: "browser.siteData.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<BrowserSiteDataListResponse>;
  };
  readonly "browser.site.signIn": {
    readonly method: "browser.site.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<BrowserSiteRequest>;
    readonly responseCheck: SchemaCheck<BrowserSiteSignInResponse>;
  };
  readonly "browser.cookie.clear": {
    readonly method: "browser.cookie.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<BrowserSiteRequest>;
    readonly responseCheck: SchemaCheck<BrowserCookieClearResponse>;
  };
  readonly "browser.siteData.forget": {
    readonly method: "browser.siteData.forget";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<BrowserSiteRequest>;
    readonly responseCheck: SchemaCheck<BrowserSiteDataForgetResponse>;
  };
  readonly "browser.siteData.clear": {
    readonly method: "browser.siteData.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<BrowserSiteDataClearResponse>;
  };
  readonly "browser.chromium.read": {
    readonly method: "browser.chromium.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<BrowserChromiumReadResponse>;
  };
  readonly "browser.chromium.fetch": {
    readonly method: "browser.chromium.fetch";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<BrowserChromiumFetchResponse>;
  };
}
/** The `browser.*` methods the daemon answers. */
export const BROWSER_METHOD_DESCRIPTORS: BrowserMethodDescriptors = Object.freeze({
  "browser.siteData.list": Object.freeze({
    method: "browser.siteData.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateBrowserSiteDataListResponse,
  }),
  "browser.site.signIn": Object.freeze({
    method: "browser.site.signIn",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateBrowserSiteRequest,
    responseCheck: validateBrowserSiteSignInResponse,
  }),
  "browser.cookie.clear": Object.freeze({
    method: "browser.cookie.clear",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateBrowserSiteRequest,
    responseCheck: validateBrowserCookieClearResponse,
  }),
  "browser.siteData.forget": Object.freeze({
    method: "browser.siteData.forget",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateBrowserSiteRequest,
    responseCheck: validateBrowserSiteDataForgetResponse,
  }),
  "browser.siteData.clear": Object.freeze({
    method: "browser.siteData.clear",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateBrowserSiteDataClearResponse,
  }),
  "browser.chromium.read": Object.freeze({
    method: "browser.chromium.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateBrowserChromiumReadResponse,
  }),
  "browser.chromium.fetch": Object.freeze({
    method: "browser.chromium.fetch",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateBrowserChromiumFetchResponse,
  }),
});
