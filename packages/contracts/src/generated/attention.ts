// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attention projection (machine-wide, whole on every emission) and the `attention.*` methods: banner settling, seen marking, and delivery beyond this machine.

import {
  type CompiledSchemaCheck,
  SCHEMA_FORMATS,
  type SchemaCheck,
  ucs2length,
} from "../schema-check.js";
import { type WireInstant, validateWireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import { type KeychainRefusalCause, validateKeychainRefusalCause } from "./keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import { type ProviderId, validateProviderId } from "./provider/id.js";
import { type SessionId, validateSessionId } from "./session/id.js";
import { type WorkflowNodeId, validateWorkflowNodeId } from "./workflow/definition/document.js";
import { type WorkflowRunId, validateWorkflowRunId } from "./workflow/run/id.js";

/**
 * The longest id an attention entry carries: its own, its moment's, its run's and its source
 * event's. The daemon mints each of them.
 */
export const ATTENTION_ID_MAX_LEN = 256 as const;

/** The longest mail password or web address the daemon accepts. */
export const ATTENTION_DELIVERY_SECRET_MAX_LEN = 8192 as const;

/** Every attention trigger; a client never invents one. */
export const ATTENTION_TRIGGERS = [
  "pendingApproval",
  "pendingInput",
  "runCompleted",
  "runFailed",
  "workflowNotify",
  "providerBuild",
] as const;

/** Every attention severity. */
export const ATTENTION_SEVERITIES = ["actionable", "informational"] as const;

/** Every banner state, for the main process's poster, which posts only pending entries. */
export const ATTENTION_BANNER_STATES = ["pending", "posted", "withheld", "withdrawn"] as const;

/**
 * Every web-address state, for the send and the status line that counts what stays
 * undelivered.
 */
export const ATTENTION_WEB_ADDRESS_STATES = ["pending", "delivered", "undelivered"] as const;

/**
 * Every attention trigger: pending approval or user input, run completion, run failure, a
 * workflow's Notify step, and a provider's new build. The set is closed.
 */
export type AttentionTrigger =
  | "pendingApproval"
  | "pendingInput"
  | "runCompleted"
  | "runFailed"
  | "workflowNotify"
  | "providerBuild";
/**
 * The two severities: `actionable` attention blocks on the person, `informational` does not. A
 * client renders the two differently.
 */
export type AttentionSeverity = "actionable" | "informational";
/**
 * The triggers of a run's or session's own moment: every trigger but a Notify step's.
 */
export type AttentionMomentTrigger =
  | "pendingApproval"
  | "pendingInput"
  | "runCompleted"
  | "runFailed";
/**
 * A banner state main settles a `pending` entry to; settling back to `pending` is refused.
 */
export type AttentionBannerSettledState = "posted" | "withheld" | "withdrawn";
/**
 * What became of an entry's operating-system banner, absent until the daemon decides it. The
 * daemon writes `withheld` when a switch or a mute keeps the entry from raising one, and `pending`
 * otherwise; main posts only a `pending` entry and settles it once, so no banner is posted twice.
 */
export type AttentionBannerState = "pending" | "posted" | "withheld" | "withdrawn";
/**
 * Where an entry's message to the person's web address stands.
 */
export type AttentionWebAddressState = "pending" | "delivered" | "undelivered";
/**
 * One attention entry.
 */
export type AttentionItem =
  | {
      /**
       * The entry.
       */
      id: string;
      /**
       * The session or run and the state it is in, so a later state replaces the
       * operating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,
       * `plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its
       * entry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and
       * execution index. A provider's build, also its entry's id, is `providerBuild:` and 32
       * hex digits of the BLAKE3 hash of the provider and the build. The daemon mints each
       * form within the 64 bytes a banner's tag and a push's collapse id hold.
       */
      momentId: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run, on a run-scoped entry.
       */
      runId?: string;
      /**
       * What raised it.
       */
      trigger: AttentionMomentTrigger;
      /**
       * Whether it blocks on the person.
       */
      severity: AttentionSeverity;
      /**
       * Never present: only a Notify step's entry names a step.
       */
      stepId?: never;
      /**
       * The name the entry leads with.
       */
      displayName: string;
      /**
       * What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice.
       */
      stateWord: string;
      /**
       * The canonical event that triggered the entry.
       */
      sourceEventId: string;
      /**
       * When the entry was made.
       */
      createdAt: WireInstant;
      /**
       * Set once the state that produced the entry resolves; absent means outstanding.
       */
      resolvedAt?: WireInstant;
      /**
       * What became of its banner; absent until the daemon decides it, and main posts only
       * `pending`.
       */
      bannerState?: AttentionBannerState;
      /**
       * Where its message to the web address stands; present exactly when it is sent there.
       */
      webAddressState?: AttentionWebAddressState;
      /**
       * How many sends it took; present exactly with `webAddressState`.
       */
      webAddressAttemptCount?: number;
      /**
       * The one seen-or-unseen fact the daemon keeps, which the session's row reads too.
       */
      seen: boolean;
    }
  | {
      /**
       * The entry.
       */
      id: string;
      /**
       * The session or run and the state it is in, so a later state replaces the
       * operating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,
       * `plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its
       * entry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and
       * execution index. A provider's build, also its entry's id, is `providerBuild:` and 32
       * hex digits of the BLAKE3 hash of the provider and the build. The daemon mints each
       * form within the 64 bytes a banner's tag and a push's collapse id hold.
       */
      momentId: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      runId: string;
      /**
       * Always `workflowNotify`.
       */
      trigger: "workflowNotify";
      /**
       * Always `informational`.
       */
      severity: "informational";
      /**
       * The Notify node.
       */
      stepId: WorkflowNodeId;
      /**
       * The name the entry leads with.
       */
      displayName: string;
      /**
       * What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice.
       */
      stateWord: string;
      /**
       * The canonical event that triggered the entry.
       */
      sourceEventId: string;
      /**
       * When the entry was made.
       */
      createdAt: WireInstant;
      /**
       * Set once the state that produced the entry resolves; absent means outstanding.
       */
      resolvedAt?: WireInstant;
      /**
       * What became of its banner; absent until the daemon decides it, and main posts only
       * `pending`.
       */
      bannerState?: AttentionBannerState;
      /**
       * Where its message to the web address stands; present exactly when it is sent there.
       */
      webAddressState?: AttentionWebAddressState;
      /**
       * How many sends it took; present exactly with `webAddressState`.
       */
      webAddressAttemptCount?: number;
      /**
       * The one seen-or-unseen fact the daemon keeps, which the session's row reads too.
       */
      seen: boolean;
    }
  | {
      /**
       * The entry, the same as its moment id.
       */
      id: string;
      /**
       * `providerBuild:` and 32 hex digits of the BLAKE3 hash of the provider and the build.
       */
      momentId: string;
      /**
       * Always `providerBuild`.
       */
      trigger: "providerBuild";
      /**
       * Always `informational`.
       */
      severity: "informational";
      /**
       * The provider's name.
       */
      displayName: string;
      /**
       * What follows the name: `updated · <from> → <to>`, or `<to> available`.
       */
      stateWord: string;
      /**
       * The build.
       */
      providerBuild: AttentionProviderBuild;
      /**
       * When the build was recorded.
       */
      createdAt: WireInstant;
      /**
       * Always `withheld`: no banner is raised for it.
       */
      bannerState: "withheld";
    };
/**
 * How far an `attention.subscribe` that names a session narrows the projection.
 */
export type AttentionSubscribeScope = "run" | "session";
/**
 * The two ways a moment leaves the machine.
 */
export type AttentionDeliveryChannel = "webAddress" | "emailDigest";
/**
 * How one delivery attempt ended.
 */
export type AttentionDeliveryResult =
  | "delivered"
  | "refused"
  | "unreachable"
  | "timedOut"
  | "signInRefused"
  | "notEncrypted"
  | "storeUnavailable";
/**
 * Why a channel's secret could not be used: the keychain is locked or cannot be opened, or the web
 * address is saved with a signing secret that is missing or damaged. The email digest never reads
 * `secretMissing` or `secretDamaged`, since a missing mail password is
 * `attention.delivery.notConfigured`.
 */
export type AttentionDeliveryStoreUnavailableCause =
  | "locked"
  | "unavailable"
  | "secretMissing"
  | "secretDamaged";
/**
 * What a channel asked to test is missing: the web address, or the mail password.
 */
export type AttentionDeliveryMissing = "address" | "password";

/**
 * A provider's new build: the build its command moved from and to, with the address of the
 * provider's own release notes for the new build, or a build only available, with neither.
 * Versions are as the command printed them, never ordered.
 */
export interface AttentionProviderBuild {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The build the command moved from; absent on a build only available.
   */
  fromVersion?: string;
  /**
   * The new build.
   */
  toVersion: string;
  /**
   * The provider's official release notes for the new build; present exactly with
   * `fromVersion`.
   */
  releaseNotesAddress?: string;
}
/**
 * The whole projection, as every emission of `attention.subscribe` carries it.
 */
export interface AttentionProjection {
  /**
   * Every entry.
   */
  items: AttentionItem[];
}
/**
 * `attention.subscribe`: with no session named, the whole projection across every session and
 * workflow run; naming a session narrows it to that session's entries, or by `scope`. `runId`
 * is present exactly when `scope` is `run`, so a run read never widens to every run, and a
 * `scope` needs a session.
 */
export interface AttentionSubscribeRequest {
  /**
   * The session to narrow to.
   */
  sessionId?: SessionId;
  /**
   * How far to narrow, present only with `sessionId`; absent reads the run entries and the
   * aggregate together.
   */
  scope?: AttentionSubscribeScope;
  /**
   * The run, present exactly when `scope` is `run`.
   */
  runId?: string;
}
/**
 * `attention.banner.settle`: main's record of what became of a `pending` entry's banner. Only this
 * machine's main sends it: the daemon answers `{}` and changes nothing for a settle from another
 * device or for an entry that has left `pending`.
 */
export interface AttentionBannerSettleRequest {
  /**
   * The entry.
   */
  entryId: string;
  /**
   * What became of its banner.
   */
  state: AttentionBannerSettledState;
}
/**
 * What `attention.seen.update` marks seen: a session, or one workflow run in it, which keeps its
 * own seen fact.
 */
export interface AttentionSeenSubject {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The workflow run in it, when the run was seen rather than the session.
   */
  runId?: WorkflowRunId;
}
/**
 * `attention.seen.update`: marks a subject seen, so its finished and failed entries stop reading
 * as unseen, in the notifications list and on the session's row alike. Opening the session, or a
 * workflow run in it, sends it.
 */
export interface AttentionSeenUpdateRequest {
  /**
   * What was seen.
   */
  subject: AttentionSeenSubject;
}
/**
 * A channel's last attempt. `httpStatus` is the address's answer, `null` where it gave none;
 * `cause` is present exactly on a `storeUnavailable` attempt; `undelivered` counts the messages
 * given up on since the last delivery.
 */
export interface AttentionDeliveryOutcome {
  /**
   * When.
   */
  at: WireInstant;
  /**
   * How it ended.
   */
  result: AttentionDeliveryResult;
  /**
   * Why the secret could not be used, on a `storeUnavailable` attempt alone.
   */
  cause?: AttentionDeliveryStoreUnavailableCause;
  /**
   * The address's HTTP status, or `null`.
   */
  httpStatus: number | null;
  /**
   * Messages given up on since the last delivery.
   */
  undelivered: number;
}
/**
 * What the web address last did. The address is shown back as its scheme and host only, present
 * exactly when an address is saved; neither the address nor its signing secret is ever sent.
 */
export interface AttentionWebAddressDelivery {
  /**
   * Whether an address is saved.
   */
  saved: boolean;
  /**
   * The saved address's scheme and host, or `null` when nothing is saved.
   */
  host: string | null;
  /**
   * Its last attempt, or `null`.
   */
  lastOutcome: AttentionDeliveryOutcome | null;
}
/**
 * What the email digest last did; the mail password is never sent.
 */
export interface AttentionEmailDigestDelivery {
  /**
   * Whether a mail password is saved.
   */
  passwordSaved: boolean;
  /**
   * Its last attempt, or `null`.
   */
  lastOutcome: AttentionDeliveryOutcome | null;
}
/**
 * What each channel last did.
 */
export interface AttentionDeliveryListResponse {
  /**
   * The web address.
   */
  webAddress: AttentionWebAddressDelivery;
  /**
   * The email digest.
   */
  emailDigest: AttentionEmailDigestDelivery;
}
/**
 * `attention.delivery.test`: sends one test message on a channel.
 */
export interface AttentionDeliveryTestRequest {
  /**
   * The channel.
   */
  channel: AttentionDeliveryChannel;
}
/**
 * How the test ended.
 */
export interface AttentionDeliveryTestResponse {
  /**
   * The attempt.
   */
  outcome: AttentionDeliveryOutcome;
}
/**
 * `attention.mailPassword.update`: saves the mail account's password. Write-only: it is sealed and
 * never sent back.
 */
export interface AttentionMailPasswordUpdateRequest {
  /**
   * The password.
   */
  password: string;
}
/**
 * `attention.webAddress.update`: saves the web address, a secret because chat services put their
 * token in it. Text that is not an `http` or `https` address with a host is refused and nothing
 * is saved.
 */
export interface AttentionWebAddressUpdateRequest {
  /**
   * The address, with an `http` or `https` scheme and a host.
   */
  address: string;
}
/**
 * The saved address's scheme and host, and the signing secret the receiver checks each message
 * with: minted by the first save and shown this once, `null` on every later save.
 */
export interface AttentionWebAddressUpdateResponse {
  /**
   * The saved address's scheme and host.
   */
  host: string;
  /**
   * The signing secret, or `null`.
   */
  signingSecret: string | null;
}
/**
 * A new signing secret, shown this once; the old one stops verifying at once.
 */
export interface AttentionWebAddressSecretRotateResponse {
  /**
   * The secret.
   */
  signingSecret: string;
}
/**
 * The `attention.delivery.storeUnavailable` refusal's details: why the keychain holding the
 * delivery secrets could not be used.
 */
export interface AttentionDeliveryStoreUnavailableDetails {
  /**
   * Why.
   */
  cause: KeychainRefusalCause;
}
/**
 * The `attention.delivery.notConfigured` refusal's details.
 */
export interface AttentionDeliveryNotConfiguredDetails {
  /**
   * What is missing.
   */
  missing: AttentionDeliveryMissing;
}

// prettier-ignore
const schema162: any = {"description":"The two severities: `actionable` attention blocks on the person, `informational` does not. A\nclient renders the two differently.","type":"string","enum":["actionable","informational"]};
/** Checks that a value is a {@link AttentionSeverity}. */
// prettier-ignore
export const validateAttentionSeverity: CompiledSchemaCheck<AttentionSeverity> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSeverity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionSeverity.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionSeverity.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "actionable") || (data === "informational"))){validateAttentionSeverity.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema162.enum}}];return false;}validateAttentionSeverity.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionSeverity.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema161: any = {"description":"The triggers of a run's or session's own moment: every trigger but a Notify step's.","type":"string","enum":["pendingApproval","pendingInput","runCompleted","runFailed"]};
/** Checks that a value is a {@link AttentionMomentTrigger}. */
// prettier-ignore
export const validateAttentionMomentTrigger: CompiledSchemaCheck<AttentionMomentTrigger> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionMomentTrigger {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionMomentTrigger.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionMomentTrigger.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "pendingApproval") || (data === "pendingInput")) || (data === "runCompleted")) || (data === "runFailed"))){validateAttentionMomentTrigger.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema161.enum}}];return false;}validateAttentionMomentTrigger.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionMomentTrigger.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema146: any = {"description":"A banner state main settles a `pending` entry to; settling back to `pending` is refused.","type":"string","enum":["posted","withheld","withdrawn"]};
/** Checks that a value is a {@link AttentionBannerSettledState}. */
// prettier-ignore
export const validateAttentionBannerSettledState: CompiledSchemaCheck<AttentionBannerSettledState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionBannerSettledState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionBannerSettledState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionBannerSettledState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "posted") || (data === "withheld")) || (data === "withdrawn"))){validateAttentionBannerSettledState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema146.enum}}];return false;}validateAttentionBannerSettledState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionBannerSettledState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema163: any = {"description":"What became of an entry's operating-system banner, absent until the daemon decides it. The\ndaemon writes `withheld` when a switch or a mute keeps the entry from raising one, and `pending`\notherwise; main posts only a `pending` entry and settles it once, so no banner is posted twice.","type":"string","enum":["pending","posted","withheld","withdrawn"]};
/** Checks that a value is a {@link AttentionBannerState}. */
// prettier-ignore
export const validateAttentionBannerState: CompiledSchemaCheck<AttentionBannerState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionBannerState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionBannerState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionBannerState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "pending") || (data === "posted")) || (data === "withheld")) || (data === "withdrawn"))){validateAttentionBannerState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema163.enum}}];return false;}validateAttentionBannerState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionBannerState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema164: any = {"description":"Where an entry's message to the person's web address stands.","type":"string","enum":["pending","delivered","undelivered"]};
/** Checks that a value is a {@link AttentionWebAddressState}. */
// prettier-ignore
export const validateAttentionWebAddressState: CompiledSchemaCheck<AttentionWebAddressState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionWebAddressState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionWebAddressState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "pending") || (data === "delivered")) || (data === "undelivered"))){validateAttentionWebAddressState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema164.enum}}];return false;}validateAttentionWebAddressState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionWebAddressState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
/** Checks that a value is a {@link AttentionProviderBuild}. */
// prettier-ignore
export const validateAttentionProviderBuild: CompiledSchemaCheck<AttentionProviderBuild> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionProviderBuild {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionProviderBuild.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.toVersion === undefined) && (missing0 = "toVersion"))){validateAttentionProviderBuild.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "provider") || (key0 === "fromVersion")) || (key0 === "toVersion")) || (key0 === "releaseNotesAddress"))){validateAttentionProviderBuild.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromVersion !== undefined){let data1: any = data.fromVersion;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.toVersion !== undefined){let data2: any = data.toVersion;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.releaseNotesAddress !== undefined){let data3: any = data.releaseNotesAddress;const _errs7: any = errors;if(errors === _errs7){if(errors === _errs7){if(typeof data3 === "string"){if(!pattern33.test(data3)){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data3))){validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validateAttentionProviderBuild.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.fromVersion !== undefined && ((data.releaseNotesAddress === undefined) && (missing1 = "releaseNotesAddress"))){validateAttentionProviderBuild.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "fromVersion",
    missingProperty: missing1,
    depsCount: 1,
    deps: "releaseNotesAddress"}}];return false;}else {if(data.releaseNotesAddress !== undefined && ((data.fromVersion === undefined) && (missing1 = "fromVersion"))){validateAttentionProviderBuild.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "releaseNotesAddress",
    missingProperty: missing1,
    depsCount: 1,
    deps: "fromVersion"}}];return false;}}}}}}}}}else {validateAttentionProviderBuild.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionProviderBuild.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionProviderBuild.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema160: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The session or run and the state it is in, so a later state replaces the\noperating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,\n`plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its\nentry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and\nexecution index. A provider's build, also its entry's id, is `providerBuild:` and 32\nhex digits of the BLAKE3 hash of the provider and the build. The daemon mints each\nform within the 64 bytes a banner's tag and a push's collapse id hold."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The run, on a run-scoped entry."},"trigger":{"$ref":"#/$defs/AttentionMomentTrigger","description":"What raised it."},"severity":{"$ref":"#/$defs/AttentionSeverity","description":"Whether it blocks on the person."},"stepId":{"not":{},"tsType":"never","description":"Never present: only a Notify step's entry names a step."},"displayName":{"type":"string","minLength":1,"description":"The name the entry leads with."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice."},"sourceEventId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The canonical event that triggered the entry."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the entry was made."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Set once the state that produced the entry resolves; absent means outstanding."},"bannerState":{"$ref":"#/$defs/AttentionBannerState","description":"What became of its banner; absent until the daemon decides it, and main posts only\n`pending`."},"webAddressState":{"$ref":"#/$defs/AttentionWebAddressState","description":"Where its message to the web address stands; present exactly when it is sent there."},"webAddressAttemptCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many sends it took; present exactly with `webAddressState`."},"seen":{"type":"boolean","description":"The one seen-or-unseen fact the daemon keeps, which the session's row reads too."}},"required":["id","momentId","sessionId","trigger","severity","displayName","stateWord","sourceEventId","createdAt","seen"],"description":"A run's or session's own moment.","dependentRequired":{"webAddressState":["webAddressAttemptCount"],"webAddressAttemptCount":["webAddressState"]}},{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The session or run and the state it is in, so a later state replaces the\noperating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,\n`plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its\nentry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and\nexecution index. A provider's build, also its entry's id, is `providerBuild:` and 32\nhex digits of the BLAKE3 hash of the provider and the build. The daemon mints each\nform within the 64 bytes a banner's tag and a push's collapse id hold."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The run."},"trigger":{"description":"Always `workflowNotify`.","type":"string","enum":["workflowNotify"]},"severity":{"description":"Always `informational`.","type":"string","enum":["informational"]},"stepId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId","description":"The Notify node."},"displayName":{"type":"string","minLength":1,"description":"The name the entry leads with."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice."},"sourceEventId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The canonical event that triggered the entry."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the entry was made."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Set once the state that produced the entry resolves; absent means outstanding."},"bannerState":{"$ref":"#/$defs/AttentionBannerState","description":"What became of its banner; absent until the daemon decides it, and main posts only\n`pending`."},"webAddressState":{"$ref":"#/$defs/AttentionWebAddressState","description":"Where its message to the web address stands; present exactly when it is sent there."},"webAddressAttemptCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many sends it took; present exactly with `webAddressState`."},"seen":{"type":"boolean","description":"The one seen-or-unseen fact the daemon keeps, which the session's row reads too."}},"required":["id","momentId","sessionId","runId","trigger","severity","stepId","displayName","stateWord","sourceEventId","createdAt","seen"],"description":"A workflow's Notify step.","dependentRequired":{"webAddressState":["webAddressAttemptCount"],"webAddressAttemptCount":["webAddressState"]}},{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry, the same as its moment id."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"`providerBuild:` and 32 hex digits of the BLAKE3 hash of the provider and the build."},"trigger":{"description":"Always `providerBuild`.","type":"string","enum":["providerBuild"]},"severity":{"description":"Always `informational`.","type":"string","enum":["informational"]},"displayName":{"type":"string","minLength":1,"description":"The provider's name."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `updated · <from> → <to>`, or `<to> available`."},"providerBuild":{"$ref":"#/$defs/AttentionProviderBuild","description":"The build."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the build was recorded."},"bannerState":{"description":"Always `withheld`: no banner is raised for it.","type":"string","enum":["withheld"]}},"required":["id","momentId","trigger","severity","displayName","stateWord","providerBuild","createdAt","bannerState"],"description":"A provider's new build, which belongs to no session; last, so a session's entry never\nreads as it."}],"description":"One attention entry."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link AttentionItem}. */
// prettier-ignore
export const validateAttentionItem: CompiledSchemaCheck<AttentionItem> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionItem {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionItem.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.id === undefined) && (missing0 = "id")) || ((data.momentId === undefined) && (missing0 = "momentId"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.trigger === undefined) && (missing0 = "trigger"))) || ((data.severity === undefined) && (missing0 = "severity"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.stateWord === undefined) && (missing0 = "stateWord"))) || ((data.sourceEventId === undefined) && (missing0 = "sourceEventId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.seen === undefined) && (missing0 = "seen"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(func2.call(schema160.anyOf[0].properties, key0))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs4: any = errors;if(errors === _errs4){if(typeof data0 === "string"){if(func1(data0) > 256){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data0) < 1){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern5.test(data0)){const err4: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.momentId !== undefined){let data1: any = data.momentId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){const err6: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(func1(data1) < 1){const err7: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(!pattern5.test(data1)){const err8: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}else {const err9: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){const _errs8: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.runId !== undefined){let data3: any = data.runId;const _errs9: any = errors;if(errors === _errs9){if(typeof data3 === "string"){if(func1(data3) > 256){const err10: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}else {if(func1(data3) < 1){const err11: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {if(!pattern5.test(data3)){const err12: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}}}}else {const err13: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}}var valid1: any = _errs9 === errors;}else {var valid1: any = true;}if(valid1){if(data.trigger !== undefined){const _errs11: any = errors;if(!(validateAttentionMomentTrigger.call(this, data.trigger, {instancePath:instancePath+"/trigger",parentData:data,parentDataProperty:"trigger",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionMomentTrigger.errors : vErrors.concat(validateAttentionMomentTrigger.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;}else {var valid1: any = true;}if(valid1){if(data.severity !== undefined){const _errs12: any = errors;if(!(validateAttentionSeverity.call(this, data.severity, {instancePath:instancePath+"/severity",parentData:data,parentDataProperty:"severity",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionSeverity.errors : vErrors.concat(validateAttentionSeverity.errors);errors = vErrors.length;}var valid1: any = _errs12 === errors;}else {var valid1: any = true;}if(valid1){if(data.stepId !== undefined){const _errs13: any = errors;const err14: any = {instancePath:instancePath+"/stepId",schemaPath:"#/anyOf/0/properties/stepId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;var valid1: any = _errs13 === errors;}else {var valid1: any = true;}if(valid1){if(data.displayName !== undefined){let data7: any = data.displayName;const _errs16: any = errors;if(errors === _errs16){if(typeof data7 === "string"){if(func1(data7) < 1){const err15: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/0/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}else {const err16: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/0/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}}var valid1: any = _errs16 === errors;}else {var valid1: any = true;}if(valid1){if(data.stateWord !== undefined){let data8: any = data.stateWord;const _errs18: any = errors;if(errors === _errs18){if(typeof data8 === "string"){if(func1(data8) < 1){const err17: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/0/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}else {const err18: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/0/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}}var valid1: any = _errs18 === errors;}else {var valid1: any = true;}if(valid1){if(data.sourceEventId !== undefined){let data9: any = data.sourceEventId;const _errs20: any = errors;if(errors === _errs20){if(typeof data9 === "string"){if(func1(data9) > 256){const err19: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}else {if(func1(data9) < 1){const err20: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;}else {if(!pattern5.test(data9)){const err21: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}}}else {const err22: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid1: any = _errs20 === errors;}else {var valid1: any = true;}if(valid1){if(data.createdAt !== undefined){const _errs22: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid1: any = _errs22 === errors;}else {var valid1: any = true;}if(valid1){if(data.resolvedAt !== undefined){const _errs23: any = errors;if(!(validateWireInstant.call(this, data.resolvedAt, {instancePath:instancePath+"/resolvedAt",parentData:data,parentDataProperty:"resolvedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid1: any = _errs23 === errors;}else {var valid1: any = true;}if(valid1){if(data.bannerState !== undefined){const _errs24: any = errors;if(!(validateAttentionBannerState.call(this, data.bannerState, {instancePath:instancePath+"/bannerState",parentData:data,parentDataProperty:"bannerState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionBannerState.errors : vErrors.concat(validateAttentionBannerState.errors);errors = vErrors.length;}var valid1: any = _errs24 === errors;}else {var valid1: any = true;}if(valid1){if(data.webAddressState !== undefined){const _errs25: any = errors;if(!(validateAttentionWebAddressState.call(this, data.webAddressState, {instancePath:instancePath+"/webAddressState",parentData:data,parentDataProperty:"webAddressState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionWebAddressState.errors : vErrors.concat(validateAttentionWebAddressState.errors);errors = vErrors.length;}var valid1: any = _errs25 === errors;}else {var valid1: any = true;}if(valid1){if(data.webAddressAttemptCount !== undefined){let data14: any = data.webAddressAttemptCount;const _errs26: any = errors;if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){const err23: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}if(errors === _errs26){if((typeof data14 == "number") && (isFinite(data14))){if(data14 > 9007199254740991 || isNaN(data14)){const err24: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}else {if(data14 < 0 || isNaN(data14)){const err25: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}}}}var valid1: any = _errs26 === errors;}else {var valid1: any = true;}if(valid1){if(data.seen !== undefined){const _errs28: any = errors;if(typeof data.seen !== "boolean"){const err26: any = {instancePath:instancePath+"/seen",schemaPath:"#/anyOf/0/properties/seen/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}var valid1: any = _errs28 === errors;}else {var valid1: any = true;}if(valid1){let missing1: any;if(data.webAddressState !== undefined && ((data.webAddressAttemptCount === undefined) && (missing1 = "webAddressAttemptCount"))){const err27: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressState",
    missingProperty: missing1,
    depsCount: 1,
    deps: "webAddressAttemptCount"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}else {if(data.webAddressAttemptCount !== undefined && ((data.webAddressState === undefined) && (missing1 = "webAddressState"))){const err28: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressAttemptCount",
    missingProperty: missing1,
    depsCount: 1,
    deps: "webAddressState"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}}}}}}}}}}}}}}}}}}}}else {const err29: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs30: any = errors;if(errors === _errs30){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((((((((data.id === undefined) && (missing2 = "id")) || ((data.momentId === undefined) && (missing2 = "momentId"))) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.runId === undefined) && (missing2 = "runId"))) || ((data.trigger === undefined) && (missing2 = "trigger"))) || ((data.severity === undefined) && (missing2 = "severity"))) || ((data.stepId === undefined) && (missing2 = "stepId"))) || ((data.displayName === undefined) && (missing2 = "displayName"))) || ((data.stateWord === undefined) && (missing2 = "stateWord"))) || ((data.sourceEventId === undefined) && (missing2 = "sourceEventId"))) || ((data.createdAt === undefined) && (missing2 = "createdAt"))) || ((data.seen === undefined) && (missing2 = "seen"))){const err30: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}else {const _errs32: any = errors;for(const key1 in data){if(!(func2.call(schema160.anyOf[1].properties, key1))){const err31: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;break;}}if(_errs32 === errors){if(data.id !== undefined){let data16: any = data.id;const _errs33: any = errors;if(errors === _errs33){if(typeof data16 === "string"){if(func1(data16) > 256){const err32: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}else {if(func1(data16) < 1){const err33: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}else {if(!pattern5.test(data16)){const err34: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}}}}else {const err35: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}}var valid2: any = _errs33 === errors;}else {var valid2: any = true;}if(valid2){if(data.momentId !== undefined){let data17: any = data.momentId;const _errs35: any = errors;if(errors === _errs35){if(typeof data17 === "string"){if(func1(data17) > 256){const err36: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}else {if(func1(data17) < 1){const err37: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}else {if(!pattern5.test(data17)){const err38: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}}}}else {const err39: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}var valid2: any = _errs35 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs37: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs37 === errors;}else {var valid2: any = true;}if(valid2){if(data.runId !== undefined){let data19: any = data.runId;const _errs38: any = errors;if(errors === _errs38){if(typeof data19 === "string"){if(func1(data19) > 256){const err40: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}else {if(func1(data19) < 1){const err41: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}else {if(!pattern5.test(data19)){const err42: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}}}}else {const err43: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;}}var valid2: any = _errs38 === errors;}else {var valid2: any = true;}if(valid2){if(data.trigger !== undefined){let data20: any = data.trigger;const _errs40: any = errors;if(typeof data20 !== "string"){const err44: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/1/properties/trigger/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}if(!(data20 === "workflowNotify")){const err45: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/1/properties/trigger/enum",keyword:"enum",params:{allowedValues: schema160.anyOf[1].properties.trigger.enum}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;}var valid2: any = _errs40 === errors;}else {var valid2: any = true;}if(valid2){if(data.severity !== undefined){let data21: any = data.severity;const _errs42: any = errors;if(typeof data21 !== "string"){const err46: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/1/properties/severity/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}if(!(data21 === "informational")){const err47: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/1/properties/severity/enum",keyword:"enum",params:{allowedValues: schema160.anyOf[1].properties.severity.enum}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}var valid2: any = _errs42 === errors;}else {var valid2: any = true;}if(valid2){if(data.stepId !== undefined){const _errs44: any = errors;if(!(validateWorkflowNodeId.call(this, data.stepId, {instancePath:instancePath+"/stepId",parentData:data,parentDataProperty:"stepId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid2: any = _errs44 === errors;}else {var valid2: any = true;}if(valid2){if(data.displayName !== undefined){let data23: any = data.displayName;const _errs45: any = errors;if(errors === _errs45){if(typeof data23 === "string"){if(func1(data23) < 1){const err48: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/1/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}}else {const err49: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/1/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}}var valid2: any = _errs45 === errors;}else {var valid2: any = true;}if(valid2){if(data.stateWord !== undefined){let data24: any = data.stateWord;const _errs47: any = errors;if(errors === _errs47){if(typeof data24 === "string"){if(func1(data24) < 1){const err50: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/1/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;}}else {const err51: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/1/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;}}var valid2: any = _errs47 === errors;}else {var valid2: any = true;}if(valid2){if(data.sourceEventId !== undefined){let data25: any = data.sourceEventId;const _errs49: any = errors;if(errors === _errs49){if(typeof data25 === "string"){if(func1(data25) > 256){const err52: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;}else {if(func1(data25) < 1){const err53: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err53];}else {vErrors.push(err53);}errors++;}else {if(!pattern5.test(data25)){const err54: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err54];}else {vErrors.push(err54);}errors++;}}}}else {const err55: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err55];}else {vErrors.push(err55);}errors++;}}var valid2: any = _errs49 === errors;}else {var valid2: any = true;}if(valid2){if(data.createdAt !== undefined){const _errs51: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs51 === errors;}else {var valid2: any = true;}if(valid2){if(data.resolvedAt !== undefined){const _errs52: any = errors;if(!(validateWireInstant.call(this, data.resolvedAt, {instancePath:instancePath+"/resolvedAt",parentData:data,parentDataProperty:"resolvedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs52 === errors;}else {var valid2: any = true;}if(valid2){if(data.bannerState !== undefined){const _errs53: any = errors;if(!(validateAttentionBannerState.call(this, data.bannerState, {instancePath:instancePath+"/bannerState",parentData:data,parentDataProperty:"bannerState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionBannerState.errors : vErrors.concat(validateAttentionBannerState.errors);errors = vErrors.length;}var valid2: any = _errs53 === errors;}else {var valid2: any = true;}if(valid2){if(data.webAddressState !== undefined){const _errs54: any = errors;if(!(validateAttentionWebAddressState.call(this, data.webAddressState, {instancePath:instancePath+"/webAddressState",parentData:data,parentDataProperty:"webAddressState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionWebAddressState.errors : vErrors.concat(validateAttentionWebAddressState.errors);errors = vErrors.length;}var valid2: any = _errs54 === errors;}else {var valid2: any = true;}if(valid2){if(data.webAddressAttemptCount !== undefined){let data30: any = data.webAddressAttemptCount;const _errs55: any = errors;if(!(((typeof data30 == "number") && (!(data30 % 1) && !isNaN(data30))) && (isFinite(data30)))){const err56: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err56];}else {vErrors.push(err56);}errors++;}if(errors === _errs55){if((typeof data30 == "number") && (isFinite(data30))){if(data30 > 9007199254740991 || isNaN(data30)){const err57: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err57];}else {vErrors.push(err57);}errors++;}else {if(data30 < 0 || isNaN(data30)){const err58: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err58];}else {vErrors.push(err58);}errors++;}}}}var valid2: any = _errs55 === errors;}else {var valid2: any = true;}if(valid2){if(data.seen !== undefined){const _errs57: any = errors;if(typeof data.seen !== "boolean"){const err59: any = {instancePath:instancePath+"/seen",schemaPath:"#/anyOf/1/properties/seen/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err59];}else {vErrors.push(err59);}errors++;}var valid2: any = _errs57 === errors;}else {var valid2: any = true;}if(valid2){let missing3: any;if(data.webAddressState !== undefined && ((data.webAddressAttemptCount === undefined) && (missing3 = "webAddressAttemptCount"))){const err60: any = {instancePath,schemaPath:"#/anyOf/1/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressState",
    missingProperty: missing3,
    depsCount: 1,
    deps: "webAddressAttemptCount"}};if(vErrors === null){vErrors = [err60];}else {vErrors.push(err60);}errors++;}else {if(data.webAddressAttemptCount !== undefined && ((data.webAddressState === undefined) && (missing3 = "webAddressState"))){const err61: any = {instancePath,schemaPath:"#/anyOf/1/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressAttemptCount",
    missingProperty: missing3,
    depsCount: 1,
    deps: "webAddressState"}};if(vErrors === null){vErrors = [err61];}else {vErrors.push(err61);}errors++;}}}}}}}}}}}}}}}}}}}}}else {const err62: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err62];}else {vErrors.push(err62);}errors++;}}var _valid0: any = _errs30 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs59: any = errors;if(errors === _errs59){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((((((data.id === undefined) && (missing4 = "id")) || ((data.momentId === undefined) && (missing4 = "momentId"))) || ((data.trigger === undefined) && (missing4 = "trigger"))) || ((data.severity === undefined) && (missing4 = "severity"))) || ((data.displayName === undefined) && (missing4 = "displayName"))) || ((data.stateWord === undefined) && (missing4 = "stateWord"))) || ((data.providerBuild === undefined) && (missing4 = "providerBuild"))) || ((data.createdAt === undefined) && (missing4 = "createdAt"))) || ((data.bannerState === undefined) && (missing4 = "bannerState"))){const err63: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err63];}else {vErrors.push(err63);}errors++;}else {const _errs61: any = errors;for(const key2 in data){if(!(func2.call(schema160.anyOf[2].properties, key2))){const err64: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err64];}else {vErrors.push(err64);}errors++;break;}}if(_errs61 === errors){if(data.id !== undefined){let data32: any = data.id;const _errs62: any = errors;if(errors === _errs62){if(typeof data32 === "string"){if(func1(data32) > 256){const err65: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err65];}else {vErrors.push(err65);}errors++;}else {if(func1(data32) < 1){const err66: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err66];}else {vErrors.push(err66);}errors++;}else {if(!pattern5.test(data32)){const err67: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err67];}else {vErrors.push(err67);}errors++;}}}}else {const err68: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err68];}else {vErrors.push(err68);}errors++;}}var valid3: any = _errs62 === errors;}else {var valid3: any = true;}if(valid3){if(data.momentId !== undefined){let data33: any = data.momentId;const _errs64: any = errors;if(errors === _errs64){if(typeof data33 === "string"){if(func1(data33) > 256){const err69: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err69];}else {vErrors.push(err69);}errors++;}else {if(func1(data33) < 1){const err70: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err70];}else {vErrors.push(err70);}errors++;}else {if(!pattern5.test(data33)){const err71: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err71];}else {vErrors.push(err71);}errors++;}}}}else {const err72: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err72];}else {vErrors.push(err72);}errors++;}}var valid3: any = _errs64 === errors;}else {var valid3: any = true;}if(valid3){if(data.trigger !== undefined){let data34: any = data.trigger;const _errs66: any = errors;if(typeof data34 !== "string"){const err73: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/2/properties/trigger/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err73];}else {vErrors.push(err73);}errors++;}if(!(data34 === "providerBuild")){const err74: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/2/properties/trigger/enum",keyword:"enum",params:{allowedValues: schema160.anyOf[2].properties.trigger.enum}};if(vErrors === null){vErrors = [err74];}else {vErrors.push(err74);}errors++;}var valid3: any = _errs66 === errors;}else {var valid3: any = true;}if(valid3){if(data.severity !== undefined){let data35: any = data.severity;const _errs68: any = errors;if(typeof data35 !== "string"){const err75: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/2/properties/severity/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err75];}else {vErrors.push(err75);}errors++;}if(!(data35 === "informational")){const err76: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/2/properties/severity/enum",keyword:"enum",params:{allowedValues: schema160.anyOf[2].properties.severity.enum}};if(vErrors === null){vErrors = [err76];}else {vErrors.push(err76);}errors++;}var valid3: any = _errs68 === errors;}else {var valid3: any = true;}if(valid3){if(data.displayName !== undefined){let data36: any = data.displayName;const _errs70: any = errors;if(errors === _errs70){if(typeof data36 === "string"){if(func1(data36) < 1){const err77: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/2/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err77];}else {vErrors.push(err77);}errors++;}}else {const err78: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/2/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err78];}else {vErrors.push(err78);}errors++;}}var valid3: any = _errs70 === errors;}else {var valid3: any = true;}if(valid3){if(data.stateWord !== undefined){let data37: any = data.stateWord;const _errs72: any = errors;if(errors === _errs72){if(typeof data37 === "string"){if(func1(data37) < 1){const err79: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/2/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err79];}else {vErrors.push(err79);}errors++;}}else {const err80: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/2/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err80];}else {vErrors.push(err80);}errors++;}}var valid3: any = _errs72 === errors;}else {var valid3: any = true;}if(valid3){if(data.providerBuild !== undefined){const _errs74: any = errors;if(!(validateAttentionProviderBuild.call(this, data.providerBuild, {instancePath:instancePath+"/providerBuild",parentData:data,parentDataProperty:"providerBuild",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionProviderBuild.errors : vErrors.concat(validateAttentionProviderBuild.errors);errors = vErrors.length;}var valid3: any = _errs74 === errors;}else {var valid3: any = true;}if(valid3){if(data.createdAt !== undefined){const _errs75: any = errors;if(!(validateWireInstant.call(this, data.createdAt, {instancePath:instancePath+"/createdAt",parentData:data,parentDataProperty:"createdAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid3: any = _errs75 === errors;}else {var valid3: any = true;}if(valid3){if(data.bannerState !== undefined){let data40: any = data.bannerState;const _errs76: any = errors;if(typeof data40 !== "string"){const err81: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/anyOf/2/properties/bannerState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err81];}else {vErrors.push(err81);}errors++;}if(!(data40 === "withheld")){const err82: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/anyOf/2/properties/bannerState/enum",keyword:"enum",params:{allowedValues: schema160.anyOf[2].properties.bannerState.enum}};if(vErrors === null){vErrors = [err82];}else {vErrors.push(err82);}errors++;}var valid3: any = _errs76 === errors;}else {var valid3: any = true;}}}}}}}}}}}}else {const err83: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err83];}else {vErrors.push(err83);}errors++;}}var _valid0: any = _errs59 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err84: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err84];}else {vErrors.push(err84);}errors++;validateAttentionItem.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateAttentionItem.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateAttentionItem.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionProjection}. */
// prettier-ignore
export const validateAttentionProjection: CompiledSchemaCheck<AttentionProjection> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionProjection {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionProjection.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.items === undefined) && (missing0 = "items")){validateAttentionProjection.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "items")){validateAttentionProjection.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.items !== undefined){let data0: any = data.items;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateAttentionItem.call(this, data0[i0], {instancePath:instancePath+"/items/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionItem.errors : vErrors.concat(validateAttentionItem.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateAttentionProjection.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateAttentionProjection.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionProjection.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionProjection.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema171: any = {"description":"How far an `attention.subscribe` that names a session narrows the projection.","type":"string","enum":["run","session"]};
/** Checks that a value is a {@link AttentionSubscribeScope}. */
// prettier-ignore
export const validateAttentionSubscribeScope: CompiledSchemaCheck<AttentionSubscribeScope> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSubscribeScope {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionSubscribeScope.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionSubscribeScope.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "run") || (data === "session"))){validateAttentionSubscribeScope.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema171.enum}}];return false;}validateAttentionSubscribeScope.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionSubscribeScope.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionSubscribeRequest}. */
// prettier-ignore
export const validateAttentionSubscribeRequest: CompiledSchemaCheck<AttentionSubscribeRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionSubscribeRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.scope === undefined) && (missing0 = "scope")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.scope !== undefined){if("run" !== data.scope){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs4: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.runId === undefined) && (missing1 = "runId")){validateAttentionSubscribeRequest.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}var _valid0: any = _errs4 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.runId = true;props0.scope = true;}ifClause0 = "then";}else {const _errs5: any = errors;const _errs6: any = errors;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.runId === undefined) && (missing2 = "runId")){const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid2: any = _errs7 === errors;if(valid2){validateAttentionSubscribeRequest.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var _valid0: any = _errs5 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateAttentionSubscribeRequest.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs8: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "scope")) || (key0 === "runId"))){validateAttentionSubscribeRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs8 === errors){if(data.sessionId !== undefined){const _errs9: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid3: any = _errs9 === errors;}else {var valid3: any = true;}if(valid3){if(data.scope !== undefined){const _errs10: any = errors;if(!(validateAttentionSubscribeScope.call(this, data.scope, {instancePath:instancePath+"/scope",parentData:data,parentDataProperty:"scope",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionSubscribeScope.errors : vErrors.concat(validateAttentionSubscribeScope.errors);errors = vErrors.length;}var valid3: any = _errs10 === errors;}else {var valid3: any = true;}if(valid3){if(data.runId !== undefined){let data3: any = data.runId;const _errs11: any = errors;if(errors === _errs11){if(typeof data3 === "string"){if(func1(data3) > 256){validateAttentionSubscribeRequest.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validateAttentionSubscribeRequest.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateAttentionSubscribeRequest.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionSubscribeRequest.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs11 === errors;}else {var valid3: any = true;}if(valid3){let missing3: any;if(data.scope !== undefined && ((data.sessionId === undefined) && (missing3 = "sessionId"))){validateAttentionSubscribeRequest.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "scope",
    missingProperty: missing3,
    depsCount: 1,
    deps: "sessionId"}}];return false;}}}}}}else {validateAttentionSubscribeRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionSubscribeRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionSubscribeRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionBannerSettleRequest}. */
// prettier-ignore
export const validateAttentionBannerSettleRequest: CompiledSchemaCheck<AttentionBannerSettleRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionBannerSettleRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionBannerSettleRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.entryId === undefined) && (missing0 = "entryId")) || ((data.state === undefined) && (missing0 = "state"))){validateAttentionBannerSettleRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "entryId") || (key0 === "state"))){validateAttentionBannerSettleRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.entryId !== undefined){let data0: any = data.entryId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validateAttentionBannerSettleRequest.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validateAttentionBannerSettleRequest.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateAttentionBannerSettleRequest.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionBannerSettleRequest.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateAttentionBannerSettledState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionBannerSettledState.errors : vErrors.concat(validateAttentionBannerSettledState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateAttentionBannerSettleRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionBannerSettleRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionBannerSettleRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionSeenSubject}. */
// prettier-ignore
export const validateAttentionSeenSubject: CompiledSchemaCheck<AttentionSeenSubject> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSeenSubject {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionSeenSubject.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validateAttentionSeenSubject.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validateAttentionSeenSubject.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateWorkflowRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowRunId.errors : vErrors.concat(validateWorkflowRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAttentionSeenSubject.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionSeenSubject.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionSeenSubject.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionSeenUpdateRequest}. */
// prettier-ignore
export const validateAttentionSeenUpdateRequest: CompiledSchemaCheck<AttentionSeenUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSeenUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionSeenUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.subject === undefined) && (missing0 = "subject")){validateAttentionSeenUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "subject")){validateAttentionSeenUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subject !== undefined){if(!(validateAttentionSeenSubject.call(this, data.subject, {instancePath:instancePath+"/subject",parentData:data,parentDataProperty:"subject",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionSeenSubject.errors : vErrors.concat(validateAttentionSeenSubject.errors);errors = vErrors.length;}}}}}else {validateAttentionSeenUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionSeenUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionSeenUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema158: any = {"description":"The two ways a moment leaves the machine.","type":"string","enum":["webAddress","emailDigest"]};
/** Checks that a value is a {@link AttentionDeliveryChannel}. */
// prettier-ignore
export const validateAttentionDeliveryChannel: CompiledSchemaCheck<AttentionDeliveryChannel> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryChannel {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryChannel.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionDeliveryChannel.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "webAddress") || (data === "emailDigest"))){validateAttentionDeliveryChannel.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema158.enum}}];return false;}validateAttentionDeliveryChannel.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryChannel.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema150: any = {"description":"How one delivery attempt ended.","type":"string","enum":["delivered","refused","unreachable","timedOut","signInRefused","notEncrypted","storeUnavailable"]};
/** Checks that a value is a {@link AttentionDeliveryResult}. */
// prettier-ignore
export const validateAttentionDeliveryResult: CompiledSchemaCheck<AttentionDeliveryResult> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryResult {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryResult.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionDeliveryResult.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data === "delivered") || (data === "refused")) || (data === "unreachable")) || (data === "timedOut")) || (data === "signInRefused")) || (data === "notEncrypted")) || (data === "storeUnavailable"))){validateAttentionDeliveryResult.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema150.enum}}];return false;}validateAttentionDeliveryResult.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryResult.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema151: any = {"description":"Why a channel's secret could not be used: the keychain is locked or cannot be opened, or the web\naddress is saved with a signing secret that is missing or damaged. The email digest never reads\n`secretMissing` or `secretDamaged`, since a missing mail password is\n`attention.delivery.notConfigured`.","type":"string","enum":["locked","unavailable","secretMissing","secretDamaged"]};
/** Checks that a value is a {@link AttentionDeliveryStoreUnavailableCause}. */
// prettier-ignore
export const validateAttentionDeliveryStoreUnavailableCause: CompiledSchemaCheck<AttentionDeliveryStoreUnavailableCause> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryStoreUnavailableCause {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryStoreUnavailableCause.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionDeliveryStoreUnavailableCause.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "locked") || (data === "unavailable")) || (data === "secretMissing")) || (data === "secretDamaged"))){validateAttentionDeliveryStoreUnavailableCause.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema151.enum}}];return false;}validateAttentionDeliveryStoreUnavailableCause.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryStoreUnavailableCause.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema149: any = {"type":"object","additionalProperties":false,"properties":{"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When."},"result":{"$ref":"#/$defs/AttentionDeliveryResult","description":"How it ended."},"cause":{"$ref":"#/$defs/AttentionDeliveryStoreUnavailableCause","description":"Why the secret could not be used, on a `storeUnavailable` attempt alone."},"httpStatus":{"type":["integer","null"],"minimum":100,"maximum":599,"description":"The address's HTTP status, or `null`."},"undelivered":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Messages given up on since the last delivery."}},"required":["at","result","httpStatus","undelivered"],"description":"A channel's last attempt. `httpStatus` is the address's answer, `null` where it gave none;\n`cause` is present exactly on a `storeUnavailable` attempt; `undelivered` counts the messages\ngiven up on since the last delivery.","if":{"type":"object","properties":{"result":{"const":"storeUnavailable"}},"required":["result"]},"then":{"type":"object","properties":{"cause":true},"required":["cause"]},"else":{"type":"object","not":{"required":["cause"]}}};
/** Checks that a value is a {@link AttentionDeliveryOutcome}. */
// prettier-ignore
export const validateAttentionDeliveryOutcome: CompiledSchemaCheck<AttentionDeliveryOutcome> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryOutcome {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryOutcome.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.result === undefined) && (missing0 = "result")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.result !== undefined){if("storeUnavailable" !== data.result){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.cause === undefined) && (missing1 = "cause")){validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs5 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.cause = true;props0.result = true;}ifClause0 = "then";}else {const _errs7: any = errors;if(!(data && typeof data == "object" && !Array.isArray(data))){validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/else/type",keyword:"type",params:{type: "object"}}];return false;}const _errs9: any = errors;const _errs10: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.cause === undefined) && (missing2 = "cause")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid2: any = _errs10 === errors;if(valid2){validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs7 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err4: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validateAttentionDeliveryOutcome.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.at === undefined) && (missing3 = "at")) || ((data.result === undefined) && (missing3 = "result"))) || ((data.httpStatus === undefined) && (missing3 = "httpStatus"))) || ((data.undelivered === undefined) && (missing3 = "undelivered"))){validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs11: any = errors;for(const key0 in data){if(!(((((key0 === "at") || (key0 === "result")) || (key0 === "cause")) || (key0 === "httpStatus")) || (key0 === "undelivered"))){validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs11 === errors){if(data.at !== undefined){const _errs12: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data.result !== undefined){const _errs13: any = errors;if(!(validateAttentionDeliveryResult.call(this, data.result, {instancePath:instancePath+"/result",parentData:data,parentDataProperty:"result",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryResult.errors : vErrors.concat(validateAttentionDeliveryResult.errors);errors = vErrors.length;}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}if(valid3){if(data.cause !== undefined){const _errs14: any = errors;if(!(validateAttentionDeliveryStoreUnavailableCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryStoreUnavailableCause.errors : vErrors.concat(validateAttentionDeliveryStoreUnavailableCause.errors);errors = vErrors.length;}var valid3: any = _errs14 === errors;}else {var valid3: any = true;}if(valid3){if(data.httpStatus !== undefined){let data4: any = data.httpStatus;const _errs15: any = errors;if((!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))) && (data4 !== null)){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/type",keyword:"type",params:{type: schema149.properties.httpStatus.type}}];return false;}if(errors === _errs15){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 599 || isNaN(data4)){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/maximum",keyword:"maximum",params:{comparison: "<=", limit: 599}}];return false;}else {if(data4 < 100 || isNaN(data4)){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/minimum",keyword:"minimum",params:{comparison: ">=", limit: 100}}];return false;}}}}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.undelivered !== undefined){let data5: any = data.undelivered;const _errs17: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateAttentionDeliveryOutcome.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs17 === errors;}else {var valid3: any = true;}}}}}}}}else {validateAttentionDeliveryOutcome.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryOutcome.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryOutcome.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema148: any = {"type":"object","additionalProperties":false,"properties":{"saved":{"type":"boolean","description":"Whether an address is saved."},"host":{"type":["string","null"],"minLength":1,"description":"The saved address's scheme and host, or `null` when nothing is saved."},"lastOutcome":{"anyOf":[{"$ref":"#/$defs/AttentionDeliveryOutcome"},{"type":"null"}],"description":"Its last attempt, or `null`."}},"required":["saved","host","lastOutcome"],"description":"What the web address last did. The address is shown back as its scheme and host only, present\nexactly when an address is saved; neither the address nor its signing secret is ever sent.","if":{"type":"object","properties":{"saved":{"const":false}},"required":["saved"]},"then":{"type":"object","properties":{"host":{"type":"null"}}},"else":{"type":"object","properties":{"host":{"type":"string"}}}};
/** Checks that a value is a {@link AttentionWebAddressDelivery}. */
// prettier-ignore
export const validateAttentionWebAddressDelivery: CompiledSchemaCheck<AttentionWebAddressDelivery> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressDelivery {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionWebAddressDelivery.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.saved === undefined) && (missing0 = "saved")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.saved !== undefined){if(false !== data.saved){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){if(data.host !== undefined){if(data.host !== null){validateAttentionWebAddressDelivery.errors = [{instancePath:instancePath+"/host",schemaPath:"#/then/properties/host/type",keyword:"type",params:{type: "null"}}];return false;}}}else {validateAttentionWebAddressDelivery.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs5 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.host = true;props0.saved = true;}ifClause0 = "then";}else {const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){if(data.host !== undefined){if(typeof data.host !== "string"){validateAttentionWebAddressDelivery.errors = [{instancePath:instancePath+"/host",schemaPath:"#/else/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}}else {validateAttentionWebAddressDelivery.errors = [{instancePath,schemaPath:"#/else/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs9 === errors;valid0 = _valid0;if(valid0){if(props0 !== true){props0 = props0 || {};props0.host = true;}}ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateAttentionWebAddressDelivery.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.saved === undefined) && (missing1 = "saved")) || ((data.host === undefined) && (missing1 = "host"))) || ((data.lastOutcome === undefined) && (missing1 = "lastOutcome"))){validateAttentionWebAddressDelivery.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key0 in data){if(!(((key0 === "saved") || (key0 === "host")) || (key0 === "lastOutcome"))){validateAttentionWebAddressDelivery.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs13 === errors){if(data.saved !== undefined){const _errs14: any = errors;if(typeof data.saved !== "boolean"){validateAttentionWebAddressDelivery.errors = [{instancePath:instancePath+"/saved",schemaPath:"#/properties/saved/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.host !== undefined){let data4: any = data.host;const _errs16: any = errors;if((typeof data4 !== "string") && (data4 !== null)){validateAttentionWebAddressDelivery.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: schema148.properties.host.type}}];return false;}if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) < 1){validateAttentionWebAddressDelivery.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.lastOutcome !== undefined){let data5: any = data.lastOutcome;const _errs18: any = errors;const _errs19: any = errors;let valid5: any = false;const _errs20: any = errors;if(!(validateAttentionDeliveryOutcome.call(this, data5, {instancePath:instancePath+"/lastOutcome",parentData:data,parentDataProperty:"lastOutcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryOutcome.errors : vErrors.concat(validateAttentionDeliveryOutcome.errors);errors = vErrors.length;}var _valid1: any = _errs20 === errors;valid5 = valid5 || _valid1;const _errs21: any = errors;if(data5 !== null){const err4: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid1: any = _errs21 === errors;valid5 = valid5 || _valid1;if(!valid5){const err5: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validateAttentionWebAddressDelivery.errors = vErrors;return false;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}else {validateAttentionWebAddressDelivery.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionWebAddressDelivery.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionWebAddressDelivery.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionEmailDigestDelivery}. */
// prettier-ignore
export const validateAttentionEmailDigestDelivery: CompiledSchemaCheck<AttentionEmailDigestDelivery> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionEmailDigestDelivery {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionEmailDigestDelivery.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.passwordSaved === undefined) && (missing0 = "passwordSaved")) || ((data.lastOutcome === undefined) && (missing0 = "lastOutcome"))){validateAttentionEmailDigestDelivery.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "passwordSaved") || (key0 === "lastOutcome"))){validateAttentionEmailDigestDelivery.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passwordSaved !== undefined){const _errs2: any = errors;if(typeof data.passwordSaved !== "boolean"){validateAttentionEmailDigestDelivery.errors = [{instancePath:instancePath+"/passwordSaved",schemaPath:"#/properties/passwordSaved/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastOutcome !== undefined){let data1: any = data.lastOutcome;const _errs4: any = errors;const _errs5: any = errors;let valid1: any = false;const _errs6: any = errors;if(!(validateAttentionDeliveryOutcome.call(this, data1, {instancePath:instancePath+"/lastOutcome",parentData:data,parentDataProperty:"lastOutcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryOutcome.errors : vErrors.concat(validateAttentionDeliveryOutcome.errors);errors = vErrors.length;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;const _errs7: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs7 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validateAttentionEmailDigestDelivery.errors = vErrors;return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateAttentionEmailDigestDelivery.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionEmailDigestDelivery.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionEmailDigestDelivery.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionDeliveryListResponse}. */
// prettier-ignore
export const validateAttentionDeliveryListResponse: CompiledSchemaCheck<AttentionDeliveryListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.webAddress === undefined) && (missing0 = "webAddress")) || ((data.emailDigest === undefined) && (missing0 = "emailDigest"))){validateAttentionDeliveryListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "webAddress") || (key0 === "emailDigest"))){validateAttentionDeliveryListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.webAddress !== undefined){const _errs2: any = errors;if(!(validateAttentionWebAddressDelivery.call(this, data.webAddress, {instancePath:instancePath+"/webAddress",parentData:data,parentDataProperty:"webAddress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionWebAddressDelivery.errors : vErrors.concat(validateAttentionWebAddressDelivery.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.emailDigest !== undefined){const _errs3: any = errors;if(!(validateAttentionEmailDigestDelivery.call(this, data.emailDigest, {instancePath:instancePath+"/emailDigest",parentData:data,parentDataProperty:"emailDigest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionEmailDigestDelivery.errors : vErrors.concat(validateAttentionEmailDigestDelivery.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateAttentionDeliveryListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionDeliveryTestRequest}. */
// prettier-ignore
export const validateAttentionDeliveryTestRequest: CompiledSchemaCheck<AttentionDeliveryTestRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryTestRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryTestRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.channel === undefined) && (missing0 = "channel")){validateAttentionDeliveryTestRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "channel")){validateAttentionDeliveryTestRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.channel !== undefined){if(!(validateAttentionDeliveryChannel.call(this, data.channel, {instancePath:instancePath+"/channel",parentData:data,parentDataProperty:"channel",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryChannel.errors : vErrors.concat(validateAttentionDeliveryChannel.errors);errors = vErrors.length;}}}}}else {validateAttentionDeliveryTestRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryTestRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryTestRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionDeliveryTestResponse}. */
// prettier-ignore
export const validateAttentionDeliveryTestResponse: CompiledSchemaCheck<AttentionDeliveryTestResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryTestResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryTestResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.outcome === undefined) && (missing0 = "outcome")){validateAttentionDeliveryTestResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "outcome")){validateAttentionDeliveryTestResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.outcome !== undefined){if(!(validateAttentionDeliveryOutcome.call(this, data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryOutcome.errors : vErrors.concat(validateAttentionDeliveryOutcome.errors);errors = vErrors.length;}}}}}else {validateAttentionDeliveryTestResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryTestResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryTestResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionMailPasswordUpdateRequest}. */
// prettier-ignore
export const validateAttentionMailPasswordUpdateRequest: CompiledSchemaCheck<AttentionMailPasswordUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionMailPasswordUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionMailPasswordUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.password === undefined) && (missing0 = "password")){validateAttentionMailPasswordUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "password")){validateAttentionMailPasswordUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.password !== undefined){let data0: any = data.password;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validateAttentionMailPasswordUpdateRequest.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validateAttentionMailPasswordUpdateRequest.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateAttentionMailPasswordUpdateRequest.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionMailPasswordUpdateRequest.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateAttentionMailPasswordUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionMailPasswordUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionMailPasswordUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionWebAddressUpdateRequest}. */
// prettier-ignore
export const validateAttentionWebAddressUpdateRequest: CompiledSchemaCheck<AttentionWebAddressUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionWebAddressUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.address === undefined) && (missing0 = "address")){validateAttentionWebAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "address")){validateAttentionWebAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.address !== undefined){let data0: any = data.address;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validateAttentionWebAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validateAttentionWebAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateAttentionWebAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateAttentionWebAddressUpdateRequest.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateAttentionWebAddressUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionWebAddressUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionWebAddressUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema174: any = {"type":"object","additionalProperties":false,"properties":{"host":{"type":"string","minLength":1,"description":"The saved address's scheme and host."},"signingSecret":{"type":["string","null"],"minLength":1,"description":"The signing secret, or `null`."}},"required":["host","signingSecret"],"description":"The saved address's scheme and host, and the signing secret the receiver checks each message\nwith: minted by the first save and shown this once, `null` on every later save."};
/** Checks that a value is a {@link AttentionWebAddressUpdateResponse}. */
// prettier-ignore
export const validateAttentionWebAddressUpdateResponse: CompiledSchemaCheck<AttentionWebAddressUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionWebAddressUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.host === undefined) && (missing0 = "host")) || ((data.signingSecret === undefined) && (missing0 = "signingSecret"))){validateAttentionWebAddressUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "host") || (key0 === "signingSecret"))){validateAttentionWebAddressUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){let data0: any = data.host;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateAttentionWebAddressUpdateResponse.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateAttentionWebAddressUpdateResponse.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.signingSecret !== undefined){let data1: any = data.signingSecret;const _errs4: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validateAttentionWebAddressUpdateResponse.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/type",keyword:"type",params:{type: schema174.properties.signingSecret.type}}];return false;}if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateAttentionWebAddressUpdateResponse.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateAttentionWebAddressUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionWebAddressUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionWebAddressUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionWebAddressSecretRotateResponse}. */
// prettier-ignore
export const validateAttentionWebAddressSecretRotateResponse: CompiledSchemaCheck<AttentionWebAddressSecretRotateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressSecretRotateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionWebAddressSecretRotateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.signingSecret === undefined) && (missing0 = "signingSecret")){validateAttentionWebAddressSecretRotateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "signingSecret")){validateAttentionWebAddressSecretRotateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.signingSecret !== undefined){let data0: any = data.signingSecret;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validateAttentionWebAddressSecretRotateResponse.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateAttentionWebAddressSecretRotateResponse.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validateAttentionWebAddressSecretRotateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionWebAddressSecretRotateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionWebAddressSecretRotateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionDeliveryStoreUnavailableDetails}. */
// prettier-ignore
export const validateAttentionDeliveryStoreUnavailableDetails: CompiledSchemaCheck<AttentionDeliveryStoreUnavailableDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryStoreUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryStoreUnavailableDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validateAttentionDeliveryStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validateAttentionDeliveryStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){if(!(validateKeychainRefusalCause.call(this, data.cause, {instancePath:instancePath+"/cause",parentData:data,parentDataProperty:"cause",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateKeychainRefusalCause.errors : vErrors.concat(validateKeychainRefusalCause.errors);errors = vErrors.length;}}}}}else {validateAttentionDeliveryStoreUnavailableDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryStoreUnavailableDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryStoreUnavailableDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema154: any = {"description":"What a channel asked to test is missing: the web address, or the mail password.","type":"string","enum":["address","password"]};
/** Checks that a value is a {@link AttentionDeliveryMissing}. */
// prettier-ignore
export const validateAttentionDeliveryMissing: CompiledSchemaCheck<AttentionDeliveryMissing> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryMissing {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryMissing.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateAttentionDeliveryMissing.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "address") || (data === "password"))){validateAttentionDeliveryMissing.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema154.enum}}];return false;}validateAttentionDeliveryMissing.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryMissing.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionDeliveryNotConfiguredDetails}. */
// prettier-ignore
export const validateAttentionDeliveryNotConfiguredDetails: CompiledSchemaCheck<AttentionDeliveryNotConfiguredDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryNotConfiguredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateAttentionDeliveryNotConfiguredDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.missing === undefined) && (missing0 = "missing")){validateAttentionDeliveryNotConfiguredDetails.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "missing")){validateAttentionDeliveryNotConfiguredDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.missing !== undefined){if(!(validateAttentionDeliveryMissing.call(this, data.missing, {instancePath:instancePath+"/missing",parentData:data,parentDataProperty:"missing",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAttentionDeliveryMissing.errors : vErrors.concat(validateAttentionDeliveryMissing.errors);errors = vErrors.length;}}}}}else {validateAttentionDeliveryNotConfiguredDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateAttentionDeliveryNotConfiguredDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateAttentionDeliveryNotConfiguredDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link ATTENTION_METHOD_DESCRIPTORS}, each with its checks. */
export interface AttentionMethodDescriptors {
  readonly "attention.subscribe": {
    readonly method: "attention.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<AttentionSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<AttentionProjection>;
  };
  readonly "attention.banner.settle": {
    readonly method: "attention.banner.settle";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AttentionBannerSettleRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "attention.seen.update": {
    readonly method: "attention.seen.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AttentionSeenUpdateRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "attention.delivery.list": {
    readonly method: "attention.delivery.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AttentionDeliveryListResponse>;
  };
  readonly "attention.delivery.test": {
    readonly method: "attention.delivery.test";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AttentionDeliveryTestRequest>;
    readonly responseCheck: SchemaCheck<AttentionDeliveryTestResponse>;
  };
  readonly "attention.mailPassword.update": {
    readonly method: "attention.mailPassword.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AttentionMailPasswordUpdateRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "attention.mailPassword.delete": {
    readonly method: "attention.mailPassword.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "attention.webAddress.update": {
    readonly method: "attention.webAddress.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<AttentionWebAddressUpdateRequest>;
    readonly responseCheck: SchemaCheck<AttentionWebAddressUpdateResponse>;
  };
  readonly "attention.webAddress.secret.rotate": {
    readonly method: "attention.webAddress.secret.rotate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<AttentionWebAddressSecretRotateResponse>;
  };
  readonly "attention.webAddress.delete": {
    readonly method: "attention.webAddress.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The `attention.*` methods. */
export const ATTENTION_METHOD_DESCRIPTORS: AttentionMethodDescriptors = Object.freeze({
  "attention.subscribe": Object.freeze({
    method: "attention.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateAttentionSubscribeRequest,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateAttentionProjection,
  }),
  "attention.banner.settle": Object.freeze({
    method: "attention.banner.settle",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAttentionBannerSettleRequest,
    responseCheck: validateEmptyPayload,
  }),
  "attention.seen.update": Object.freeze({
    method: "attention.seen.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAttentionSeenUpdateRequest,
    responseCheck: validateEmptyPayload,
  }),
  "attention.delivery.list": Object.freeze({
    method: "attention.delivery.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAttentionDeliveryListResponse,
  }),
  "attention.delivery.test": Object.freeze({
    method: "attention.delivery.test",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAttentionDeliveryTestRequest,
    responseCheck: validateAttentionDeliveryTestResponse,
  }),
  "attention.mailPassword.update": Object.freeze({
    method: "attention.mailPassword.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAttentionMailPasswordUpdateRequest,
    responseCheck: validateEmptyPayload,
  }),
  "attention.mailPassword.delete": Object.freeze({
    method: "attention.mailPassword.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
  "attention.webAddress.update": Object.freeze({
    method: "attention.webAddress.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateAttentionWebAddressUpdateRequest,
    responseCheck: validateAttentionWebAddressUpdateResponse,
  }),
  "attention.webAddress.secret.rotate": Object.freeze({
    method: "attention.webAddress.secret.rotate",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateAttentionWebAddressSecretRotateResponse,
  }),
  "attention.webAddress.delete": Object.freeze({
    method: "attention.webAddress.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateEmptyPayload,
    responseCheck: validateEmptyPayload,
  }),
});
