// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The service's lifecycle verbs: stop, restart, the flush at quit and the ping on a quiet link.

import type { SchemaCheck } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";

/**
 * The words the service's ready line carries, written once it answers on its socket;
 * whoever started the process waits for a line that holds them.
 */
export const DAEMON_READY_LINE = "The daemon is ready" as const;

/**
 * The longest a stopping service's drain runs, in milliseconds: its terminals' drain and
 * time beside it for a write still running to finish rather than roll back. A client that saw
 * a stop or restart taken waits this long for the service to exit before it signals it, so no
 * signal cuts the drain short.
 */
export const DAEMON_STOP_DRAIN_BOUND_MS = 4000 as const;

/**
 * The service took the stop or restart.
 */
export interface DaemonLifecycleAccepted {
  /**
   * Always `true`.
   */
  accepted: true;
}
/**
 * Every write pending when the flush arrived is durable.
 */
export interface DaemonFlushResponse {
  /**
   * Always `true`.
   */
  flushed: true;
}

// prettier-ignore
function validate347(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonFlushResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate347.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.flushed === undefined) && (missing0 = "flushed")){validate347.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "flushed")){validate347.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.flushed !== undefined){let data0: any = data.flushed;if(typeof data0 !== "boolean"){validate347.errors = [{instancePath:instancePath+"/flushed",schemaPath:"#/properties/flushed/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate347.errors = [{instancePath:instancePath+"/flushed",schemaPath:"#/properties/flushed/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate347.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate347.errors = vErrors;return errors === 0;}
// prettier-ignore
validate347.errors = null as any[] | null;
// prettier-ignore
validate347.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate348(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonLifecycleAccepted {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate348.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.accepted === undefined) && (missing0 = "accepted")){validate348.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "accepted")){validate348.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.accepted !== undefined){let data0: any = data.accepted;if(typeof data0 !== "boolean"){validate348.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/type",keyword:"type",params:{type: "boolean"}}];return false;}if(true !== data0){validate348.errors = [{instancePath:instancePath+"/accepted",schemaPath:"#/properties/accepted/const",keyword:"const",params:{allowedValue: true}}];return false;}}}}}else {validate348.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate348.errors = vErrors;return errors === 0;}
// prettier-ignore
validate348.errors = null as any[] | null;
// prettier-ignore
validate348.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonFlushResponse}. */
export const validateDaemonFlushResponse: SchemaCheck<DaemonFlushResponse> = validate347;
/** Checks that a value is a {@link DaemonLifecycleAccepted}. */
export const validateDaemonLifecycleAccepted: SchemaCheck<DaemonLifecycleAccepted> = validate348;

/** The methods of {@link DAEMON_LIFECYCLE_METHOD_DESCRIPTORS}, each with its checks. */
export interface DaemonLifecycleMethodDescriptors {
  readonly "daemon.stop": {
    readonly method: "daemon.stop";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonLifecycleAccepted>;
  };
  readonly "daemon.restart": {
    readonly method: "daemon.restart";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonLifecycleAccepted>;
  };
  readonly "daemon.flush": {
    readonly method: "daemon.flush";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<DaemonFlushResponse>;
  };
  readonly "daemon.ping": {
    readonly method: "daemon.ping";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/**
 * The lifecycle verbs. Every verb takes an empty request; none is ever refused, so the
 * service can always be stopped, restarted or flushed.
 */
export const DAEMON_LIFECYCLE_METHOD_DESCRIPTORS: DaemonLifecycleMethodDescriptors = Object.freeze({
  "daemon.stop": Object.freeze({
    method: "daemon.stop",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonLifecycleAccepted,
  }),
  "daemon.restart": Object.freeze({
    method: "daemon.restart",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonLifecycleAccepted,
  }),
  "daemon.flush": Object.freeze({
    method: "daemon.flush",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateDaemonFlushResponse,
  }),
  "daemon.ping": Object.freeze({
    method: "daemon.ping",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
});
