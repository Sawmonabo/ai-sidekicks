// Workflow secrets: the records the step's Credential chooser lists and manages, the
// `secret://<scope>/<name>` reference a node's sensitive parameter stores, the four
// `workflow.secret*` methods, and the three refusals a secret answers with.
//
// A secret's value is sealed in the operating system's keychain by the daemon. The value
// crosses the wire once, inward, as `secretValue` on a create or a replace; it is on no
// reply, event, log or error, and a document, a step record or a log holds only the
// reference. A reference resolves only in the step that runs, and only in a parameter
// its kind marks sensitive.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

/** A secret record's id. The daemon mints it. */
export type WorkflowSecretId = string & { readonly __brand: "WorkflowSecretId" };
/** Wire schema for {@link WorkflowSecretId}. */
export const WorkflowSecretIdSchema: z.ZodType<WorkflowSecretId, WorkflowSecretId> =
  brandedUuidIdSchema<WorkflowSecretId>("WorkflowSecretId");

/**
 * Where a secret is visible: one project's workflows, or every workflow on this machine.
 * Never a session.
 */
export type WorkflowSecretScope = "project" | "shared";

/** The longest a secret's name may be. */
export const WORKFLOW_SECRET_NAME_MAX_LEN = 64;

// Lowercase letters, digits and hyphens, starting with a letter or digit.
const WORKFLOW_SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Whether a name keeps the secret-name rule. The daemon refuses a create whose name
 * breaks it with {@link WORKFLOW_SECRET_NAME_INVALID_CODE}, reason `pattern`, and the
 * chooser checks the same rule while the name is typed.
 */
export function isWorkflowSecretName(name: string): boolean {
  return name.length <= WORKFLOW_SECRET_NAME_MAX_LEN && WORKFLOW_SECRET_NAME_PATTERN.test(name);
}

/**
 * A secret's place: `project` with `scopeRef`, the project's identity as a
 * project-scoped workflow definition names it, or `shared` with none.
 */
export type WorkflowSecretPlace = { scope: "project"; scopeRef: string } | { scope: "shared" };

const projectPlaceShape = { scope: z.literal("project"), scopeRef: z.string().min(1) };
const sharedPlaceShape = { scope: z.literal("shared") };

/** One secret as the chooser lists it: its place and name, and never its value. */
export type WorkflowSecretSummary = {
  secretId: WorkflowSecretId;
  name: string;
} & WorkflowSecretPlace;
/** Wire schema for {@link WorkflowSecretSummary}. */
export const WorkflowSecretSummarySchema: z.ZodType<WorkflowSecretSummary> = z.discriminatedUnion(
  "scope",
  [
    z
      .object({ secretId: WorkflowSecretIdSchema, name: z.string().min(1), ...projectPlaceShape })
      .strict(),
    z
      .object({ secretId: WorkflowSecretIdSchema, name: z.string().min(1), ...sharedPlaceShape })
      .strict(),
  ],
);

// --------------------------------------------------------------------------
// The reference
// --------------------------------------------------------------------------

const WORKFLOW_SECRET_REFERENCE_FORM = /^secret:\/\/(project|shared)\/([^/]+)$/u;

/** What a `secret://` reference names: a scope and a name within it. */
export interface WorkflowSecretReference {
  scope: WorkflowSecretScope;
  name: string;
}

/** Writes the reference a sensitive parameter stores: `secret://<scope>/<name>`. */
export function composeWorkflowSecretReference(reference: WorkflowSecretReference): string {
  return `secret://${reference.scope}/${reference.name}`;
}

/**
 * Reads a reference back, or returns `null` when the text is not exactly one: another
 * scheme, a scope other than `project` or `shared`, or a name that breaks the rule. The
 * daemon's check at save uses it to find a reference outside a sensitive parameter.
 */
export function parseWorkflowSecretReference(text: string): WorkflowSecretReference | null {
  const match = WORKFLOW_SECRET_REFERENCE_FORM.exec(text);
  if (match === null) {
    return null;
  }
  const [, scope, name] = match;
  return (scope === "project" || scope === "shared") &&
    name !== undefined &&
    isWorkflowSecretName(name)
    ? { scope, name }
    : null;
}

// --------------------------------------------------------------------------
// The methods
// --------------------------------------------------------------------------

/**
 * The `workflow.secretCreate` input. The daemon seals `secretValue` in the keychain
 * before it writes the record, so a keychain that cannot take it leaves no record.
 * `name` is checked by the daemon, which refuses a name that breaks the rule or that
 * the place already holds, with {@link WORKFLOW_SECRET_NAME_INVALID_CODE}.
 */
export type WorkflowSecretCreateRequest = {
  name: string;
  secretValue: string;
} & WorkflowSecretPlace;
/** Wire schema for {@link WorkflowSecretCreateRequest}. */
export const WorkflowSecretCreateRequestSchema: z.ZodType<
  WorkflowSecretCreateRequest,
  WorkflowSecretCreateRequest
> = z.discriminatedUnion("scope", [
  z.object({ name: z.string(), secretValue: z.string().min(1), ...projectPlaceShape }).strict(),
  z.object({ name: z.string(), secretValue: z.string().min(1), ...sharedPlaceShape }).strict(),
]);

/** The `workflow.secretCreate` result: the new record, without its value. */
export type WorkflowSecretCreateResponse = WorkflowSecretSummary;
/** Wire schema for {@link WorkflowSecretCreateResponse}. */
export const WorkflowSecretCreateResponseSchema: z.ZodType<WorkflowSecretCreateResponse> =
  WorkflowSecretSummarySchema;

/**
 * The `workflow.secretReplace` input: a new value for one secret, sealed before the
 * record's change is written.
 */
export interface WorkflowSecretReplaceRequest {
  secretId: WorkflowSecretId;
  secretValue: string;
}
/** Wire schema for {@link WorkflowSecretReplaceRequest}. */
export const WorkflowSecretReplaceRequestSchema: z.ZodType<
  WorkflowSecretReplaceRequest,
  WorkflowSecretReplaceRequest
> = z.object({ secretId: WorkflowSecretIdSchema, secretValue: z.string().min(1) }).strict();

/**
 * The `workflow.secretDelete` input. The daemon records the removal first, then removes
 * the keychain entry and the record, so a crash between the two finishes the removal. A
 * version that still names the secret fails its step with
 * {@link WORKFLOW_SECRET_NOT_FOUND_CODE}.
 */
export interface WorkflowSecretDeleteRequest {
  secretId: WorkflowSecretId;
}
/** Wire schema for {@link WorkflowSecretDeleteRequest}. */
export const WorkflowSecretDeleteRequestSchema: z.ZodType<
  WorkflowSecretDeleteRequest,
  WorkflowSecretDeleteRequest
> = z.object({ secretId: WorkflowSecretIdSchema }).strict();

/** The secret a replace or a delete acted on. */
export interface WorkflowSecretActResponse {
  secretId: WorkflowSecretId;
}
/** Wire schema for {@link WorkflowSecretActResponse}. */
export const WorkflowSecretActResponseSchema: z.ZodType<WorkflowSecretActResponse> = z
  .object({ secretId: WorkflowSecretIdSchema })
  .strict();

/**
 * The `workflow.secretList` input. With `scopeRef` it lists that project's secrets and
 * the shared ones; without it, the shared ones only, which is what a shared workflow's
 * step may use.
 */
export interface WorkflowSecretListRequest {
  scopeRef?: string | undefined;
}
/** Wire schema for {@link WorkflowSecretListRequest}. */
export const WorkflowSecretListRequestSchema: z.ZodType<
  WorkflowSecretListRequest,
  WorkflowSecretListRequest
> = z.object({ scopeRef: z.string().min(1).optional() }).strict();

/** The `workflow.secretList` result: records by name, and no member carries a value. */
export interface WorkflowSecretListResponse {
  secrets: WorkflowSecretSummary[];
}
/** Wire schema for {@link WorkflowSecretListResponse}. */
export const WorkflowSecretListResponseSchema: z.ZodType<WorkflowSecretListResponse> = z
  .object({ secrets: z.array(WorkflowSecretSummarySchema) })
  .strict();

/**
 * The wire members that carry a secret, which a transport that logs requests or replies
 * redacts by name: a secret's value, inward, and a webhook token shown once, outward.
 */
export const WORKFLOW_REDACTED_WIRE_MEMBERS: readonly string[] = ["secretValue", "token"];

// --------------------------------------------------------------------------
// Refusals
// --------------------------------------------------------------------------

/** A secret name that breaks the rule, or that its place already holds. */
export const WORKFLOW_SECRET_NAME_INVALID_CODE = "workflow.secret_name_invalid" as const;
/** The type of {@link WORKFLOW_SECRET_NAME_INVALID_CODE}. */
export type WorkflowSecretNameInvalidCode = typeof WORKFLOW_SECRET_NAME_INVALID_CODE;

/** Why a name was refused: it breaks the rule, or the place already holds it. */
export const WORKFLOW_SECRET_NAME_INVALID_REASONS = ["pattern", "taken"] as const;
/** One of {@link WORKFLOW_SECRET_NAME_INVALID_REASONS}. */
export type WorkflowSecretNameInvalidReason = (typeof WORKFLOW_SECRET_NAME_INVALID_REASONS)[number];

/** The details of {@link WORKFLOW_SECRET_NAME_INVALID_CODE}. */
export interface WorkflowSecretNameInvalidDetails {
  reason: WorkflowSecretNameInvalidReason;
}
/** Wire schema for {@link WorkflowSecretNameInvalidDetails}. */
export const WorkflowSecretNameInvalidDetailsSchema: z.ZodType<WorkflowSecretNameInvalidDetails> = z
  .object({ reason: z.enum(WORKFLOW_SECRET_NAME_INVALID_REASONS) })
  .strict();

/**
 * A step whose secret the keychain does not hold. It carries only the reference and
 * offers `Retry from this step`.
 */
export const WORKFLOW_SECRET_NOT_FOUND_CODE = "workflow.secret_not_found" as const;
/** The type of {@link WORKFLOW_SECRET_NOT_FOUND_CODE}. */
export type WorkflowSecretNotFoundCode = typeof WORKFLOW_SECRET_NOT_FOUND_CODE;

/** The details of {@link WORKFLOW_SECRET_NOT_FOUND_CODE}: the reference, as the step stored it. */
export interface WorkflowSecretNotFoundDetails {
  reference: string;
}
/** Wire schema for {@link WorkflowSecretNotFoundDetails}. */
export const WorkflowSecretNotFoundDetailsSchema: z.ZodType<WorkflowSecretNotFoundDetails> = z
  .object({
    reference: z.string().refine((reference) => parseWorkflowSecretReference(reference) !== null, {
      message: "reference must be a secret:// reference.",
    }),
  })
  .strict();

/**
 * A keychain that is locked or unavailable. A create or replace is refused, and a step
 * fails and offers `Retry from this step`; nothing waits on the keychain indefinitely,
 * and nothing falls back to a plaintext value or to an encrypted file.
 */
export const WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE = "workflow.secret_store_unavailable" as const;
/** The type of {@link WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE}. */
export type WorkflowSecretStoreUnavailableCode = typeof WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE;

/**
 * Why the keychain could not be used: it is `locked`, or this machine has none the
 * daemon can use (`unavailable`).
 */
export const WORKFLOW_SECRET_STORE_UNAVAILABLE_CAUSES = ["locked", "unavailable"] as const;
/** One of {@link WORKFLOW_SECRET_STORE_UNAVAILABLE_CAUSES}. */
export type WorkflowSecretStoreUnavailableCause =
  (typeof WORKFLOW_SECRET_STORE_UNAVAILABLE_CAUSES)[number];

/** The details of {@link WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE}. */
export interface WorkflowSecretStoreUnavailableDetails {
  cause: WorkflowSecretStoreUnavailableCause;
}
/** Wire schema for {@link WorkflowSecretStoreUnavailableDetails}. */
export const WorkflowSecretStoreUnavailableDetailsSchema: z.ZodType<WorkflowSecretStoreUnavailableDetails> =
  z.object({ cause: z.enum(WORKFLOW_SECRET_STORE_UNAVAILABLE_CAUSES) }).strict();

// --------------------------------------------------------------------------
// Method descriptors
// --------------------------------------------------------------------------

/** The `workflow.secret*` methods, keyed by name. */
export interface WorkflowSecretMethodDescriptors {
  readonly "workflow.secretCreate": MethodDescriptor<
    "workflow.secretCreate",
    WorkflowSecretCreateRequest,
    WorkflowSecretCreateResponse
  >;
  readonly "workflow.secretReplace": MethodDescriptor<
    "workflow.secretReplace",
    WorkflowSecretReplaceRequest,
    WorkflowSecretActResponse
  >;
  readonly "workflow.secretDelete": MethodDescriptor<
    "workflow.secretDelete",
    WorkflowSecretDeleteRequest,
    WorkflowSecretActResponse
  >;
  readonly "workflow.secretList": MethodDescriptor<
    "workflow.secretList",
    WorkflowSecretListRequest,
    WorkflowSecretListResponse
  >;
}

/** The workflow secrets' method table. */
export const WORKFLOW_SECRET_METHOD_DESCRIPTORS: WorkflowSecretMethodDescriptors =
  defineMethodDescriptors({
    "workflow.secretCreate": {
      method: "workflow.secretCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowSecretCreateRequestSchema,
      responseSchema: WorkflowSecretCreateResponseSchema,
    },
    "workflow.secretReplace": {
      method: "workflow.secretReplace",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowSecretReplaceRequestSchema,
      responseSchema: WorkflowSecretActResponseSchema,
    },
    "workflow.secretDelete": {
      method: "workflow.secretDelete",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowSecretDeleteRequestSchema,
      responseSchema: WorkflowSecretActResponseSchema,
    },
    "workflow.secretList": {
      method: "workflow.secretList",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowSecretListRequestSchema,
      responseSchema: WorkflowSecretListResponseSchema,
    },
  });
