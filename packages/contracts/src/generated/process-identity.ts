/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A running process as the system knows it: its id, the boot it runs in, and the system's own record of when it started.

import { type SchemaCheck, ucs2length } from "../schema-check.js";

/**
 * A process as the system knows it; two readings are of the same process exactly when equal.
 */
export interface ProcessIdentity {
  /**
   * The operating-system process id.
   */
  processId: number;
  /**
   * The id of the boot the process runs in: Linux's boot id, macOS's boot session id; on Windows
   * one fixed word, since Windows keeps no boot mark a change of the clock leaves alone.
   */
  bootId: string;
  /**
   * The system's own record of when the process started, as the system writes it: Linux's
   * clock ticks since boot, macOS's start instant, Windows' creation time. Compared only for
   * equality, never read as a time, so a change of the clock does not change it.
   */
  processStartTime: string;
}

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1386(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is ProcessIdentity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1386.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.processId === undefined) && (missing0 = "processId")) || ((data.bootId === undefined) && (missing0 = "bootId"))) || ((data.processStartTime === undefined) && (missing0 = "processStartTime"))){validate1386.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "processId") || (key0 === "bootId")) || (key0 === "processStartTime"))){validate1386.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.processId !== undefined){let data0: any = data.processId;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1386.errors = [{instancePath:instancePath+"/processId",schemaPath:"#/properties/processId/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1386.errors = [{instancePath:instancePath+"/processId",schemaPath:"#/properties/processId/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validate1386.errors = [{instancePath:instancePath+"/processId",schemaPath:"#/properties/processId/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.bootId !== undefined){let data1: any = data.bootId;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 128){validate1386.errors = [{instancePath:instancePath+"/bootId",schemaPath:"#/properties/bootId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1386.errors = [{instancePath:instancePath+"/bootId",schemaPath:"#/properties/bootId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1386.errors = [{instancePath:instancePath+"/bootId",schemaPath:"#/properties/bootId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.processStartTime !== undefined){let data2: any = data.processStartTime;const _errs6: any = errors;if(errors === _errs6){if(typeof data2 === "string"){if(func1(data2) > 128){validate1386.errors = [{instancePath:instancePath+"/processStartTime",schemaPath:"#/properties/processStartTime/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1386.errors = [{instancePath:instancePath+"/processStartTime",schemaPath:"#/properties/processStartTime/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1386.errors = [{instancePath:instancePath+"/processStartTime",schemaPath:"#/properties/processStartTime/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validate1386.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1386.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1386.errors = null as any[] | null;
// prettier-ignore
validate1386.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link ProcessIdentity}. */
export const validateProcessIdentity: SchemaCheck<ProcessIdentity> = validate1386;
