/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A repository mount's ids and states, its probed health and the payload of a health change, and the payload every `workspace.*` and `worktree.*` lifecycle event carries.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SessionId } from "../session/id.js";

/**
 * The daemon-minted id of one repository mount.
 */
export type RepoMountId = string & { readonly __brand: "RepoMountId" };
/**
 * The daemon-minted id of one workspace.
 */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
/**
 * How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's
 * own checkout), `provisionedWorktree` in a worktree the daemon provisions for it.
 */
export type ExecutionMode = "boundRoot" | "provisionedWorktree";
/**
 * A workspace's lifecycle state. `rootLost` means its working root became unavailable and write
 * runs are blocked until repair.
 */
export type WorkspaceState = "preparing" | "ready" | "rootLost" | "archived";
/**
 * A mount's lifecycle state. `detached` is terminal: re-attaching creates a new mount rather than
 * reviving the old one.
 */
export type RepoMountState = "attached" | "detached" | "archived";
/**
 * The version-control system behind a mount. `repoMount.attach` refuses a path that is not a git
 * repository, so every mount is `git`.
 */
export type VcsType = "git";
/**
 * A mount's health, probed on every read and never stored. `unreachable` means the root cannot be
 * probed and outranks the rest; `identityMismatch` means the root's git common directory is not
 * the one recorded at attach, and `isRepository` says whether git still answers for the root,
 * which decides whether re-attaching can recover it.
 */
export type RepoMountHealth =
  | {
      status: "healthy";
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
      /**
       * Only a mismatch says whether git still answers.
       */
      isRepository?: never;
    }
  | {
      status: "unreachable";
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
      /**
       * Only a mismatch says whether git still answers.
       */
      isRepository?: never;
    }
  | {
      status: "identityMismatch";
      /**
       * Whether git still answers for the root.
       */
      isRepository: boolean;
      /**
       * When it was probed.
       */
      checkedAt: WireInstant;
    };

/**
 * The `repoMount.health.changed` payload: a mount's health after the daemon's re-probe changed
 * it, sent on the stream of every session on that mount.
 */
export interface RepoMountHealthChangedPayload {
  /**
   * The mount.
   */
  repoMountId: RepoMountId;
  /**
   * Its health now.
   */
  health: RepoMountHealth;
}
/**
 * The payload of a `workspace.*` lifecycle event.
 */
export interface WorkspaceLifecyclePayload {
  /**
   * The envelope's session, repeated so a projector can read the payload alone.
   */
  sessionId: SessionId;
  /**
   * The mount, when it is the subject or beside it.
   */
  repoMountId?: RepoMountId;
  /**
   * The workspace, when it is the subject or beside it.
   */
  workspaceId?: WorkspaceId;
  /**
   * The worktree, when it is the subject.
   */
  worktreeId?: string;
  /**
   * The subject's state after the transition.
   */
  state: WorkspaceState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
}

// prettier-ignore
const schema1986: any = {"description":"How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's\nown checkout), `provisionedWorktree` in a worktree the daemon provisions for it.","type":"string","enum":["boundRoot","provisionedWorktree"]};
// prettier-ignore
function validate1674(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ExecutionMode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1674.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1674.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "boundRoot") || (data === "provisionedWorktree"))){validate1674.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}validate1674.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1674.errors = null as any[] | null;
// prettier-ignore
validate1674.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1675(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RepoMountHealth {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1675.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate1675.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.status;if(typeof tag0 == "string"){if(tag0 === "healthy"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.status === undefined) && (missing0 = "status")) || ((data.checkedAt === undefined) && (missing0 = "checkedAt"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "status") || (key1 === "checkedAt")) || (key1 === "isRepository"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.status !== undefined){let data0: any = data.status;const _errs6: any = errors;if(typeof data0 !== "string"){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("healthy" !== data0){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/const",keyword:"const",params:{allowedValue: "healthy"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.checkedAt !== undefined){let data1: any = data.checkedAt;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.isRepository !== undefined){const _errs11: any = errors;validate1675.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/0/properties/isRepository/not",keyword:"not",params:{}}];return false;var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}else {validate1675.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "unreachable"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.status === undefined) && (missing1 = "status")) || ((data.checkedAt === undefined) && (missing1 = "checkedAt"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(((key2 === "status") || (key2 === "checkedAt")) || (key2 === "isRepository"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.status !== undefined){let data3: any = data.status;const _errs17: any = errors;if(typeof data3 !== "string"){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("unreachable" !== data3){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/const",keyword:"const",params:{allowedValue: "unreachable"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.checkedAt !== undefined){let data4: any = data.checkedAt;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(!pattern5.test(data4)){validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.isRepository !== undefined){const _errs22: any = errors;validate1675.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/1/properties/isRepository/not",keyword:"not",params:{}}];return false;var valid5: any = _errs22 === errors;}else {var valid5: any = true;}}}}}}else {validate1675.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "identityMismatch"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.status === undefined) && (missing2 = "status")) || ((data.isRepository === undefined) && (missing2 = "isRepository"))) || ((data.checkedAt === undefined) && (missing2 = "checkedAt"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!(((key3 === "status") || (key3 === "isRepository")) || (key3 === "checkedAt"))){validate1675.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.status !== undefined){let data6: any = data.status;const _errs28: any = errors;if(typeof data6 !== "string"){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("identityMismatch" !== data6){validate1675.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/const",keyword:"const",params:{allowedValue: "identityMismatch"}}];return false;}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data.isRepository !== undefined){const _errs30: any = errors;if(typeof data.isRepository !== "boolean"){validate1675.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/2/properties/isRepository/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.checkedAt !== undefined){let data8: any = data.checkedAt;const _errs32: any = errors;const _errs33: any = errors;if(errors === _errs33){if(typeof data8 === "string"){if(!pattern5.test(data8)){validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1675.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}}}}}}else {validate1675.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate1675.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "status", tagValue: tag0}}];return false;}}else {validate1675.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "status", tagValue: tag0}}];return false;}}}else {validate1675.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1675.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1675.errors = null as any[] | null;
// prettier-ignore
validate1675.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate690(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate690.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate690.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.status;if(typeof tag0 == "string"){if(tag0 === "healthy"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.status === undefined) && (missing0 = "status")) || ((data.checkedAt === undefined) && (missing0 = "checkedAt"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!(((key1 === "status") || (key1 === "checkedAt")) || (key1 === "isRepository"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.status !== undefined){let data0: any = data.status;const _errs6: any = errors;if(typeof data0 !== "string"){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("healthy" !== data0){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/0/properties/status/const",keyword:"const",params:{allowedValue: "healthy"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.checkedAt !== undefined){let data1: any = data.checkedAt;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.isRepository !== undefined){const _errs11: any = errors;validate690.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/0/properties/isRepository/not",keyword:"not",params:{}}];return false;var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}else {validate690.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "unreachable"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.status === undefined) && (missing1 = "status")) || ((data.checkedAt === undefined) && (missing1 = "checkedAt"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key2 in data){if(!(((key2 === "status") || (key2 === "checkedAt")) || (key2 === "isRepository"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs16 === errors){if(data.status !== undefined){let data3: any = data.status;const _errs17: any = errors;if(typeof data3 !== "string"){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("unreachable" !== data3){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/1/properties/status/const",keyword:"const",params:{allowedValue: "unreachable"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.checkedAt !== undefined){let data4: any = data.checkedAt;const _errs19: any = errors;const _errs20: any = errors;if(errors === _errs20){if(typeof data4 === "string"){if(!pattern5.test(data4)){validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.isRepository !== undefined){const _errs22: any = errors;validate690.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/1/properties/isRepository/not",keyword:"not",params:{}}];return false;var valid5: any = _errs22 === errors;}else {var valid5: any = true;}}}}}}else {validate690.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "identityMismatch"){const _errs25: any = errors;if(errors === _errs25){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.status === undefined) && (missing2 = "status")) || ((data.isRepository === undefined) && (missing2 = "isRepository"))) || ((data.checkedAt === undefined) && (missing2 = "checkedAt"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs27: any = errors;for(const key3 in data){if(!(((key3 === "status") || (key3 === "isRepository")) || (key3 === "checkedAt"))){validate690.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs27 === errors){if(data.status !== undefined){let data6: any = data.status;const _errs28: any = errors;if(typeof data6 !== "string"){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}if("identityMismatch" !== data6){validate690.errors = [{instancePath:instancePath+"/status",schemaPath:"#/oneOf/2/properties/status/const",keyword:"const",params:{allowedValue: "identityMismatch"}}];return false;}var valid8: any = _errs28 === errors;}else {var valid8: any = true;}if(valid8){if(data.isRepository !== undefined){const _errs30: any = errors;if(typeof data.isRepository !== "boolean"){validate690.errors = [{instancePath:instancePath+"/isRepository",schemaPath:"#/oneOf/2/properties/isRepository/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid8: any = _errs30 === errors;}else {var valid8: any = true;}if(valid8){if(data.checkedAt !== undefined){let data8: any = data.checkedAt;const _errs32: any = errors;const _errs33: any = errors;if(errors === _errs33){if(typeof data8 === "string"){if(!pattern5.test(data8)){validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate690.errors = [{instancePath:instancePath+"/checkedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs32 === errors;}else {var valid8: any = true;}}}}}}else {validate690.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate690.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "status", tagValue: tag0}}];return false;}}else {validate690.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "status", tagValue: tag0}}];return false;}}}else {validate690.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate690.errors = vErrors;return errors === 0;}
// prettier-ignore
validate690.errors = null as any[] | null;
// prettier-ignore
validate690.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1676(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RepoMountHealthChangedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1676.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.repoMountId === undefined) && (missing0 = "repoMountId")) || ((data.health === undefined) && (missing0 = "health"))){validate1676.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "repoMountId") || (key0 === "health"))){validate1676.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.repoMountId !== undefined){let data0: any = data.repoMountId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1676.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1676.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.health !== undefined){const _errs6: any = errors;if(!(validate690.call(this, data.health, {instancePath:instancePath+"/health",parentData:data,parentDataProperty:"health",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate690.errors : vErrors.concat(validate690.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1676.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1676.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1676.errors = null as any[] | null;
// prettier-ignore
validate1676.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1678(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RepoMountId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1678.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1678.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1678.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1678.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1678.errors = null as any[] | null;
// prettier-ignore
validate1678.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3052: any = {"description":"A mount's lifecycle state. `detached` is terminal: re-attaching creates a new mount rather than\nreviving the old one.","type":"string","enum":["attached","detached","archived"]};
// prettier-ignore
function validate1679(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RepoMountState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1679.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1679.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "attached") || (data === "detached")) || (data === "archived"))){validate1679.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema3052.enum}}];return false;}validate1679.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1679.errors = null as any[] | null;
// prettier-ignore
validate1679.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3053: any = {"description":"The version-control system behind a mount. `repoMount.attach` refuses a path that is not a git\nrepository, so every mount is `git`.","type":"string","enum":["git"]};
// prettier-ignore
function validate1680(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is VcsType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1680.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1680.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data === "git")){validate1680.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema3053.enum}}];return false;}validate1680.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1680.errors = null as any[] | null;
// prettier-ignore
validate1680.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1681(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1681.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1681.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1681.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1681.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1681.errors = null as any[] | null;
// prettier-ignore
validate1681.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema918: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The envelope's session, repeated so a projector can read the payload alone."},"repoMountId":{"$ref":"#/$defs/RepoMountId","description":"The mount, when it is the subject or beside it."},"workspaceId":{"$ref":"#/$defs/WorkspaceId","description":"The workspace, when it is the subject or beside it."},"worktreeId":{"type":"string","pattern":"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$","description":"The worktree, when it is the subject."},"state":{"$ref":"#/$defs/WorkspaceState","description":"The subject's state after the transition."},"actor":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The envelope's actor, repeated; a system event sends `null` or leaves it out."}},"required":["sessionId","state"],"description":"The payload of a `workspace.*` lifecycle event."};
// prettier-ignore
const schema922: any = {"description":"A workspace's lifecycle state. `rootLost` means its working root became unavailable and write\nruns are blocked until repair.","type":"string","enum":["preparing","ready","rootLost","archived"]};
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1682(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceLifecyclePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1682.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validate1682.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "repoMountId")) || (key0 === "workspaceId")) || (key0 === "worktreeId")) || (key0 === "state")) || (key0 === "actor"))){validate1682.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1682.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1682.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.repoMountId !== undefined){let data1: any = data.repoMountId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1682.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"#/$defs/RepoMountId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1682.errors = [{instancePath:instancePath+"/repoMountId",schemaPath:"#/$defs/RepoMountId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.workspaceId !== undefined){let data2: any = data.workspaceId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1682.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"#/$defs/WorkspaceId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1682.errors = [{instancePath:instancePath+"/workspaceId",schemaPath:"#/$defs/WorkspaceId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.worktreeId !== undefined){let data3: any = data.worktreeId;const _errs14: any = errors;if(errors === _errs14){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate1682.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1682.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"#/properties/worktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data4: any = data.state;const _errs16: any = errors;if(typeof data4 !== "string"){validate1682.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorkspaceState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data4 === "preparing") || (data4 === "ready")) || (data4 === "rootLost")) || (data4 === "archived"))){validate1682.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/WorkspaceState/enum",keyword:"enum",params:{allowedValues: schema922.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){let data5: any = data.actor;const _errs19: any = errors;if((typeof data5 !== "string") && (data5 !== null)){validate1682.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/type",keyword:"type",params:{type: schema918.properties.actor.type}}];return false;}if(errors === _errs19){if(typeof data5 === "string"){if(func1(data5) > 256){validate1682.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1682.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1682.errors = [{instancePath:instancePath+"/actor",schemaPath:"#/properties/actor/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1682.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1682.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1682.errors = null as any[] | null;
// prettier-ignore
validate1682.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1683(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkspaceState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1683.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validate1683.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "preparing") || (data === "ready")) || (data === "rootLost")) || (data === "archived"))){validate1683.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema922.enum}}];return false;}validate1683.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1683.errors = null as any[] | null;
// prettier-ignore
validate1683.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ExecutionMode}. */
export const validateExecutionMode: SchemaCheck<ExecutionMode> = validate1674;
/** Checks that a value is a {@link RepoMountHealth}. */
export const validateRepoMountHealth: SchemaCheck<RepoMountHealth> = validate1675;
/** Checks that a value is a {@link RepoMountHealthChangedPayload}. */
export const validateRepoMountHealthChangedPayload: SchemaCheck<RepoMountHealthChangedPayload> =
  validate1676;
/** Checks that a value is a {@link RepoMountId}. */
export const validateRepoMountId: SchemaCheck<RepoMountId> = validate1678;
/** Checks that a value is a {@link RepoMountState}. */
export const validateRepoMountState: SchemaCheck<RepoMountState> = validate1679;
/** Checks that a value is a {@link VcsType}. */
export const validateVcsType: SchemaCheck<VcsType> = validate1680;
/** Checks that a value is a {@link WorkspaceId}. */
export const validateWorkspaceId: SchemaCheck<WorkspaceId> = validate1681;
/** Checks that a value is a {@link WorkspaceLifecyclePayload}. */
export const validateWorkspaceLifecyclePayload: SchemaCheck<WorkspaceLifecyclePayload> =
  validate1682;
/** Checks that a value is a {@link WorkspaceState}. */
export const validateWorkspaceState: SchemaCheck<WorkspaceState> = validate1683;
