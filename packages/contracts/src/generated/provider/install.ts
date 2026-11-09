/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `provider.install.*` and `provider.installUpdate.*` methods: installing and updating a provider's command in one place.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { ProviderId } from "./id.js";
import { type ProviderPlaceRequest, validateProviderPlaceRequest } from "./settings.js";

/** The longest install failure reason: the installer's last lines, credentials removed. */
export const PROVIDER_INSTALL_FAILURE_REASON_MAX_LEN = 4096 as const;

/** The longest installer command a failed install shows. */
export const PROVIDER_INSTALL_COMMAND_MAX_LEN = 1024 as const;

/**
 * Where one provider's install in one place has got to. The install runs the provider's own
 * installer as the person, keyed by provider and place, and the stream's first message is the
 * last outcome in that place.
 */
export type ProviderInstallProgress =
  | {
      state: "running";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "installed";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "failed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The installer's last lines, credentials removed.
       */
      reason: string;
      /**
       * The installer command, for the person to run.
       */
      command: string;
    };
/**
 * Where one provider's update in one place has got to: `Update` on its row, or the service's own
 * run when the latest-version marker names a build the command does not resolve to. The outcome
 * is read from the version the command resolves to afterwards, and the stream's first message is
 * the last outcome.
 */
export type ProviderInstallUpdateProgress =
  | {
      state: "running";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      state: "updated";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it left.
       */
      fromVersion: string;
      /**
       * The version it resolves to.
       */
      toVersion: string;
    }
  | {
      state: "current";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it resolves to.
       */
      version: string;
    }
  | {
      state: "notUpdated";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The version it still resolves to.
       */
      version: string;
      /**
       * The update's last lines, credentials removed.
       */
      reason: string;
      /**
       * The update command, for the person to run.
       */
      command: string;
    }
  | {
      state: "needsAdministrator";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The update command, for the person to run.
       */
      command: string;
    };

// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1552(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderInstallProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1552.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1552.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.state === undefined) && (missing0 = "state")) || ((data.provider === undefined) && (missing0 = "provider"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "provider"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs6: any = errors;if(typeof data0 !== "string"){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data0){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){let data1: any = data.provider;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate1552.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "installed"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.state === undefined) && (missing1 = "state")) || ((data.provider === undefined) && (missing1 = "provider"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((key2 === "state") || (key2 === "provider"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs15: any = errors;if(typeof data2 !== "string"){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("installed" !== data2){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "installed"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.provider !== undefined){let data3: any = data.provider;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern16.test(data3)){validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}}}}}else {validate1552.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "failed"){const _errs21: any = errors;if(errors === _errs21){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((data.state === undefined) && (missing2 = "state")) || ((data.provider === undefined) && (missing2 = "provider"))) || ((data.reason === undefined) && (missing2 = "reason"))) || ((data.command === undefined) && (missing2 = "command"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs23: any = errors;for(const key3 in data){if(!((((key3 === "state") || (key3 === "provider")) || (key3 === "reason")) || (key3 === "command"))){validate1552.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs23 === errors){if(data.state !== undefined){let data4: any = data.state;const _errs24: any = errors;if(typeof data4 !== "string"){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("failed" !== data4){validate1552.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "failed"}}];return false;}var valid8: any = _errs24 === errors;}else {var valid8: any = true;}if(valid8){if(data.provider !== undefined){let data5: any = data.provider;const _errs26: any = errors;const _errs27: any = errors;if(errors === _errs27){if(typeof data5 === "string"){if(!pattern16.test(data5)){validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1552.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs26 === errors;}else {var valid8: any = true;}if(valid8){if(data.reason !== undefined){let data6: any = data.reason;const _errs30: any = errors;if(errors === _errs30){if(typeof data6 === "string"){if(func1(data6) > 4096){validate1552.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data6) < 1){validate1552.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data6)){validate1552.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1552.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/2/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.command !== undefined){let data7: any = data.command;const _errs32: any = errors;if(errors === _errs32){if(typeof data7 === "string"){if(func1(data7) > 1024){validate1552.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/2/properties/command/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data7) < 1){validate1552.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/2/properties/command/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data7)){validate1552.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/2/properties/command/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1552.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/2/properties/command/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}}}}}}}else {validate1552.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1552.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate1552.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}}}else {validate1552.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1552.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1552.errors = null as any[] | null;
// prettier-ignore
validate1552.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1553(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProviderInstallUpdateProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1553.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1553.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.state;if(typeof tag0 == "string"){if(tag0 === "running"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.state === undefined) && (missing0 = "state")) || ((data.provider === undefined) && (missing0 = "provider"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "state") || (key1 === "provider"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.state !== undefined){let data0: any = data.state;const _errs6: any = errors;if(typeof data0 !== "string"){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("running" !== data0){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/0/properties/state/const",keyword:"const",params:{allowedValue: "running"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){let data1: any = data.provider;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate1553.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "updated"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((data.state === undefined) && (missing1 = "state")) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.fromVersion === undefined) && (missing1 = "fromVersion"))) || ((data.toVersion === undefined) && (missing1 = "toVersion"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!((((key2 === "state") || (key2 === "provider")) || (key2 === "fromVersion")) || (key2 === "toVersion"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.state !== undefined){let data2: any = data.state;const _errs15: any = errors;if(typeof data2 !== "string"){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("updated" !== data2){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/1/properties/state/const",keyword:"const",params:{allowedValue: "updated"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.provider !== undefined){let data3: any = data.provider;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern16.test(data3)){validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.fromVersion !== undefined){let data4: any = data.fromVersion;const _errs21: any = errors;if(errors === _errs21){if(typeof data4 === "string"){if(func1(data4) > 128){validate1553.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/oneOf/1/properties/fromVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate1553.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/oneOf/1/properties/fromVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1553.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/oneOf/1/properties/fromVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/oneOf/1/properties/fromVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}if(valid5){if(data.toVersion !== undefined){let data5: any = data.toVersion;const _errs23: any = errors;if(errors === _errs23){if(typeof data5 === "string"){if(func1(data5) > 128){validate1553.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/oneOf/1/properties/toVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data5) < 1){validate1553.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/oneOf/1/properties/toVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1553.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/oneOf/1/properties/toVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/oneOf/1/properties/toVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs23 === errors;}else {var valid5: any = true;}}}}}}}else {validate1553.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "current"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.state === undefined) && (missing2 = "state")) || ((data.provider === undefined) && (missing2 = "provider"))) || ((data.version === undefined) && (missing2 = "version"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!(((key3 === "state") || (key3 === "provider")) || (key3 === "version"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.state !== undefined){let data6: any = data.state;const _errs28: any = errors;if(typeof data6 !== "string"){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("current" !== data6){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/2/properties/state/const",keyword:"const",params:{allowedValue: "current"}}];return false;}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data.provider !== undefined){let data7: any = data.provider;const _errs30: any = errors;const _errs31: any = errors;if(errors === _errs31){if(typeof data7 === "string"){if(!pattern16.test(data7)){validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.version !== undefined){let data8: any = data.version;const _errs34: any = errors;if(errors === _errs34){if(typeof data8 === "string"){if(func1(data8) > 128){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/2/properties/version/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data8) < 1){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/2/properties/version/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data8)){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/2/properties/version/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/2/properties/version/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs34 === errors;}else {var valid8: any = true;}}}}}}else {validate1553.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "notUpdated"){const _errs36: any = errors;if(errors === _errs36){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if((((((data.state === undefined) && (missing3 = "state")) || ((data.provider === undefined) && (missing3 = "provider"))) || ((data.version === undefined) && (missing3 = "version"))) || ((data.reason === undefined) && (missing3 = "reason"))) || ((data.command === undefined) && (missing3 = "command"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs38: any = errors;for(const key4 in data){if(!(((((key4 === "state") || (key4 === "provider")) || (key4 === "version")) || (key4 === "reason")) || (key4 === "command"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs38 === errors){if(data.state !== undefined){let data9: any = data.state;const _errs39: any = errors;if(typeof data9 !== "string"){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("notUpdated" !== data9){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/3/properties/state/const",keyword:"const",params:{allowedValue: "notUpdated"}}];return false;}var valid11: any = _errs39 === errors;}else {var valid11: any = true;}if(valid11){if(data.provider !== undefined){let data10: any = data.provider;const _errs41: any = errors;const _errs42: any = errors;if(errors === _errs42){if(typeof data10 === "string"){if(!pattern16.test(data10)){validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs41 === errors;}else {var valid11: any = true;}if(valid11){if(data.version !== undefined){let data11: any = data.version;const _errs45: any = errors;if(errors === _errs45){if(typeof data11 === "string"){if(func1(data11) > 128){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/3/properties/version/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data11) < 1){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/3/properties/version/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data11)){validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/3/properties/version/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/version",schemaPath:"#/oneOf/3/properties/version/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs45 === errors;}else {var valid11: any = true;}if(valid11){if(data.reason !== undefined){let data12: any = data.reason;const _errs47: any = errors;if(errors === _errs47){if(typeof data12 === "string"){if(func1(data12) > 4096){validate1553.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data12) < 1){validate1553.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data12)){validate1553.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/oneOf/3/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs47 === errors;}else {var valid11: any = true;}if(valid11){if(data.command !== undefined){let data13: any = data.command;const _errs49: any = errors;if(errors === _errs49){if(typeof data13 === "string"){if(func1(data13) > 1024){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/3/properties/command/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data13) < 1){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/3/properties/command/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data13)){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/3/properties/command/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/3/properties/command/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs49 === errors;}else {var valid11: any = true;}}}}}}}}else {validate1553.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "needsAdministrator"){const _errs51: any = errors;if(errors === _errs51){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((data.state === undefined) && (missing4 = "state")) || ((data.provider === undefined) && (missing4 = "provider"))) || ((data.command === undefined) && (missing4 = "command"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs53: any = errors;for(const key5 in data){if(!(((key5 === "state") || (key5 === "provider")) || (key5 === "command"))){validate1553.errors = [{instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs53 === errors){if(data.state !== undefined){let data14: any = data.state;const _errs54: any = errors;if(typeof data14 !== "string"){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/type",keyword:"type",params:{type: "string"}}];return false;}if("needsAdministrator" !== data14){validate1553.errors = [{instancePath:instancePath+"/state",schemaPath:"#/oneOf/4/properties/state/const",keyword:"const",params:{allowedValue: "needsAdministrator"}}];return false;}var valid14: any = _errs54 === errors;}else {var valid14: any = true;}if(valid14){if(data.provider !== undefined){let data15: any = data.provider;const _errs56: any = errors;const _errs57: any = errors;if(errors === _errs57){if(typeof data15 === "string"){if(!pattern16.test(data15)){validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1553.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs56 === errors;}else {var valid14: any = true;}if(valid14){if(data.command !== undefined){let data16: any = data.command;const _errs60: any = errors;if(errors === _errs60){if(typeof data16 === "string"){if(func1(data16) > 1024){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/4/properties/command/maxLength",keyword:"maxLength",params:{limit: 1024}}];return false;}else {if(func1(data16) < 1){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/4/properties/command/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data16)){validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/4/properties/command/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1553.errors = [{instancePath:instancePath+"/command",schemaPath:"#/oneOf/4/properties/command/type",keyword:"type",params:{type: "string"}}];return false;}}var valid14: any = _errs60 === errors;}else {var valid14: any = true;}}}}}}else {validate1553.errors = [{instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1553.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "state", tagValue: tag0}}];return false;}}else {validate1553.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "state", tagValue: tag0}}];return false;}}}else {validate1553.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1553.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1553.errors = null as any[] | null;
// prettier-ignore
validate1553.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProviderInstallProgress}. */
export const validateProviderInstallProgress: SchemaCheck<ProviderInstallProgress> = validate1552;
/** Checks that a value is a {@link ProviderInstallUpdateProgress}. */
export const validateProviderInstallUpdateProgress: SchemaCheck<ProviderInstallUpdateProgress> =
  validate1553;

/** The methods of {@link PROVIDER_INSTALL_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderInstallMethodDescriptors {
  readonly "provider.install.start": {
    readonly method: "provider.install.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "provider.install.subscribe": {
    readonly method: "provider.install.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderInstallProgress>;
  };
  readonly "provider.install.stop": {
    readonly method: "provider.install.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "provider.installUpdate.start": {
    readonly method: "provider.installUpdate.start";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "provider.installUpdate.subscribe": {
    readonly method: "provider.installUpdate.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderPlaceRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderInstallUpdateProgress>;
  };
}
/**
 * Every `provider.install.*` and `provider.installUpdate.*` method: its name, how it answers,
 * and its shapes.
 */
export const PROVIDER_INSTALL_METHOD_DESCRIPTORS: ProviderInstallMethodDescriptors = Object.freeze({
  "provider.install.start": Object.freeze({
    method: "provider.install.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderPlaceRequest,
    responseCheck: validateEmptyPayload,
  }),
  "provider.install.subscribe": Object.freeze({
    method: "provider.install.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateProviderPlaceRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProviderInstallProgress,
  }),
  "provider.install.stop": Object.freeze({
    method: "provider.install.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderPlaceRequest,
    responseCheck: validateEmptyPayload,
  }),
  "provider.installUpdate.start": Object.freeze({
    method: "provider.installUpdate.start",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateProviderPlaceRequest,
    responseCheck: validateEmptyPayload,
  }),
  "provider.installUpdate.subscribe": Object.freeze({
    method: "provider.installUpdate.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateProviderPlaceRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateProviderInstallUpdateProgress,
  }),
});
