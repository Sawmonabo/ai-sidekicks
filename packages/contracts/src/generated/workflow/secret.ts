// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow secrets: the records a step's Credential chooser lists and manages, the `secret://<scope>/<name>` reference a node's sensitive parameter stores, the `workflow.secret.*` methods and the refusals a secret answers with.

import type { KeychainRefusalCause } from "../keychain.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { ProjectId } from "../project.js";

/**
 * Wire members a request-logging transport redacts before writing a record: the value of a
 * secret's create or update.
 */
export const WORKFLOW_SECRET_REDACTED_WIRE_MEMBERS = ["secretValue"] as const;

/**
 * A secret record's id, a UUID the daemon mints.
 */
export type WorkflowSecretId = string & { readonly __brand: "WorkflowSecretId" };
/**
 * A secret's name: lowercase letters, digits and hyphens, starting with a letter or digit, at
 * most 64 characters.
 */
export type WorkflowSecretName = string;
/**
 * Where a secret is visible: the runs that work in one project, or every run on this machine.
 * Never a session.
 */
export type WorkflowSecretScope = "project" | "shared";
/**
 * A string that is exactly one secret reference, secret://shared/<name> or secret://project/<name>.
 */
export type WorkflowSecretReference = string;
/**
 * One secret as the chooser lists it: its place and name, and never its value.
 */
export type WorkflowSecretSummary =
  | {
      scope: "project";
      /**
       * The record's id.
       */
      secretId: WorkflowSecretId;
      /**
       * The secret's name.
       */
      name: WorkflowSecretName;
      /**
       * The project record's id.
       */
      scopeRef: ProjectId;
    }
  | {
      scope: "shared";
      /**
       * The record's id.
       */
      secretId: WorkflowSecretId;
      /**
       * The secret's name.
       */
      name: WorkflowSecretName;
      /**
       * Never present: a shared secret belongs to no project.
       */
      scopeRef?: never;
    };
/**
 * The `workflow.secret.create` input: the daemon seals `secretValue` in the keychain before it
 * writes the record, so a keychain that cannot take it leaves no record. A `name` that breaks
 * the rule is refused with `workflow.secret.nameInvalid`, one the place already holds with
 * `workflow.secret.nameTaken`.
 */
export type WorkflowSecretCreateRequest =
  | {
      scope: "project";
      /**
       * The name asked for, as typed: any text, so a name that breaks the rule reaches the
       * daemon's own refusal.
       */
      name: string;
      /**
       * The value to seal.
       */
      secretValue: string;
      /**
       * The project record's id.
       */
      scopeRef: ProjectId;
    }
  | {
      scope: "shared";
      /**
       * The name asked for, as typed: any text, so a name that breaks the rule reaches the
       * daemon's own refusal.
       */
      name: string;
      /**
       * The value to seal.
       */
      secretValue: string;
      /**
       * Never present: a shared secret belongs to no project.
       */
      scopeRef?: never;
    };
/**
 * Why a secret's name was refused.
 */
export type WorkflowSecretNameInvalidReason = "pattern";
/**
 * The details of `workflow.secret.notFound`: the reference a failed step stored, or the id an
 * update or a delete named, one or the other.
 */
export type WorkflowSecretNotFoundDetails =
  | WorkflowSecretReferenceNotFound
  | WorkflowSecretRecordNotFound;

/**
 * The `workflow.secret.update` input: a new value for one secret, sealed before the record's
 * change is written.
 */
export interface WorkflowSecretUpdateRequest {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
  /**
   * The new value.
   */
  secretValue: string;
}
/**
 * The `workflow.secret.delete` input: the daemon records the removal, then removes the keychain
 * entry and the record, so a crash between the two finishes it. A version that still names the
 * secret fails its step with `workflow.secret.notFound`.
 */
export interface WorkflowSecretDeleteRequest {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
}
/**
 * The secret an update or a delete acted on.
 */
export interface WorkflowSecretActResponse {
  /**
   * The secret.
   */
  secretId: WorkflowSecretId;
}
/**
 * The `workflow.secret.list` result: every secret by name, shared and each project's, one row
 * each, and no member carries a value. The request names nothing: a workflow belongs to no
 * project, so the chooser lists them all.
 */
export interface WorkflowSecretListResponse {
  /**
   * The secrets.
   */
  secrets: WorkflowSecretSummary[];
}
/**
 * The details of `workflow.secret.nameInvalid`.
 */
export interface WorkflowSecretNameInvalidDetails {
  /**
   * Why.
   */
  reason: WorkflowSecretNameInvalidReason;
}
/**
 * A step's secret the keychain does not hold: only the reference, as the step stored it.
 */
export interface WorkflowSecretReferenceNotFound {
  /**
   * The reference.
   */
  reference: WorkflowSecretReference;
  /**
   * Never present: a step names its secret by reference.
   */
  secretId?: never;
}
/**
 * An update or a delete naming a secret no record holds.
 */
export interface WorkflowSecretRecordNotFound {
  /**
   * Never present: an update or a delete names its secret by id.
   */
  reference?: never;
  /**
   * The id asked for.
   */
  secretId: WorkflowSecretId;
}
/**
 * The details of `workflow.secret.storeUnavailable`: why the keychain could not be used. A create
 * or update is refused, and a step fails and offers `Retry from this step`, never waiting on the
 * keychain or keeping the value anywhere else.
 */
export interface WorkflowSecretStoreUnavailableDetails {
  /**
   * Why.
   */
  cause: KeychainRefusalCause;
}

/** The methods of {@link WORKFLOW_SECRET_METHOD_DESCRIPTORS}, each with its kind. */
export interface WorkflowSecretMethodDescriptors {
  readonly "workflow.secret.create": {
    readonly method: "workflow.secret.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.secret.update": {
    readonly method: "workflow.secret.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.secret.delete": {
    readonly method: "workflow.secret.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "workflow.secret.list": {
    readonly method: "workflow.secret.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
}
/** The params, result and emission types of each method of {@link WORKFLOW_SECRET_METHOD_DESCRIPTORS}. */
export interface WorkflowSecretMethodTypes {
  readonly "workflow.secret.create": {
    readonly params: WorkflowSecretCreateRequest;
    readonly result: WorkflowSecretSummary;
  };
  readonly "workflow.secret.update": {
    readonly params: WorkflowSecretUpdateRequest;
    readonly result: WorkflowSecretActResponse;
  };
  readonly "workflow.secret.delete": {
    readonly params: WorkflowSecretDeleteRequest;
    readonly result: WorkflowSecretActResponse;
  };
  readonly "workflow.secret.list": {
    readonly params: EmptyPayload;
    readonly result: WorkflowSecretListResponse;
  };
}
/** The workflow secrets' method table. */
export const WORKFLOW_SECRET_METHOD_DESCRIPTORS: WorkflowSecretMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.secret.create": /* @__PURE__ */ Object.freeze({
      method: "workflow.secret.create",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.secret.update": /* @__PURE__ */ Object.freeze({
      method: "workflow.secret.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.secret.delete": /* @__PURE__ */ Object.freeze({
      method: "workflow.secret.delete",
      procedureType: "mutation",
      mutating: true,
    }),
    "workflow.secret.list": /* @__PURE__ */ Object.freeze({
      method: "workflow.secret.list",
      procedureType: "query",
      mutating: false,
    }),
  });
