/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attention projection (machine-wide, whole on every emission) and the `attention.*` methods: banner settling, seen marking, and delivery beyond this machine.

import { SCHEMA_FORMATS, type SchemaCheck, ucs2length } from "../schema-check.js";
import type { WireInstant } from "./internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "./jsonrpc/streaming.js";
import type { KeychainRefusalCause } from "./keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "./method-descriptor.js";
import type { ProviderId } from "./provider/id.js";
import type { SessionId } from "./session/id.js";
import type { WorkflowNodeId } from "./workflow/definition/document.js";
import type { WorkflowRunId } from "./workflow/run/id.js";

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
const schema432: any = {"description":"A banner state main settles a `pending` entry to; settling back to `pending` is refused.","type":"string","enum":["posted","withheld","withdrawn"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate230(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionBannerSettleRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate230.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.entryId === undefined) && (missing0 = "entryId")) || ((data.state === undefined) && (missing0 = "state"))){validate230.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "entryId") || (key0 === "state"))){validate230.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.entryId !== undefined){let data0: any = data.entryId;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 256){validate230.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate230.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate230.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate230.errors = [{instancePath:instancePath+"/entryId",schemaPath:"#/properties/entryId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs4: any = errors;if(typeof data1 !== "string"){validate230.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/AttentionBannerSettledState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "posted") || (data1 === "withheld")) || (data1 === "withdrawn"))){validate230.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/AttentionBannerSettledState/enum",keyword:"enum",params:{allowedValues: schema432.enum}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate230.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate230.errors = vErrors;return errors === 0;}
// prettier-ignore
validate230.errors = null as any[] | null;
// prettier-ignore
validate230.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema434: any = {"type":"object","additionalProperties":false,"properties":{"saved":{"type":"boolean","description":"Whether an address is saved."},"host":{"type":["string","null"],"minLength":1,"description":"The saved address's scheme and host, or `null` when nothing is saved."},"lastOutcome":{"anyOf":[{"$ref":"#/$defs/AttentionDeliveryOutcome"},{"type":"null"}],"description":"Its last attempt, or `null`."}},"required":["saved","host","lastOutcome"],"description":"What the web address last did. The address is shown back as its scheme and host only, present\nexactly when an address is saved; neither the address nor its signing secret is ever sent.","if":{"type":"object","properties":{"saved":{"const":false}},"required":["saved"]},"then":{"type":"object","properties":{"host":{"type":"null"}}},"else":{"type":"object","properties":{"host":{"type":"string"}}}};
// prettier-ignore
const schema435: any = {"type":"object","additionalProperties":false,"properties":{"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When."},"result":{"$ref":"#/$defs/AttentionDeliveryResult","description":"How it ended."},"cause":{"$ref":"#/$defs/AttentionDeliveryStoreUnavailableCause","description":"Why the secret could not be used, on a `storeUnavailable` attempt alone."},"httpStatus":{"type":["integer","null"],"minimum":100,"maximum":599,"description":"The address's HTTP status, or `null`."},"undelivered":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"Messages given up on since the last delivery."}},"required":["at","result","httpStatus","undelivered"],"description":"A channel's last attempt. `httpStatus` is the address's answer, `null` where it gave none;\n`cause` is present exactly on a `storeUnavailable` attempt; `undelivered` counts the messages\ngiven up on since the last delivery.","if":{"type":"object","properties":{"result":{"const":"storeUnavailable"}},"required":["result"]},"then":{"type":"object","properties":{"cause":true},"required":["cause"]},"else":{"type":"object","not":{"required":["cause"]}}};
// prettier-ignore
const schema437: any = {"description":"How one delivery attempt ended.","type":"string","enum":["delivered","refused","unreachable","timedOut","signInRefused","notEncrypted","storeUnavailable"]};
// prettier-ignore
const schema438: any = {"description":"Why a channel's secret could not be used: the keychain is locked or cannot be opened, or the web\naddress is saved with a signing secret that is missing or damaged. The email digest never reads\n`secretMissing` or `secretDamaged`, since a missing mail password is\n`attention.delivery.notConfigured`.","type":"string","enum":["locked","unavailable","secretMissing","secretDamaged"]};
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate233(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate233.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.result === undefined) && (missing0 = "result")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.result !== undefined){if("storeUnavailable" !== data.result){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.cause === undefined) && (missing1 = "cause")){validate233.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}else {validate233.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs5 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.cause = true;props0.result = true;}ifClause0 = "then";}else {const _errs7: any = errors;if(!(data && typeof data == "object" && !Array.isArray(data))){validate233.errors = [{instancePath,schemaPath:"#/else/type",keyword:"type",params:{type: "object"}}];return false;}const _errs9: any = errors;const _errs10: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.cause === undefined) && (missing2 = "cause")){const err3: any = {};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid2: any = _errs10 === errors;if(valid2){validate233.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var _valid0: any = _errs7 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err4: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate233.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.at === undefined) && (missing3 = "at")) || ((data.result === undefined) && (missing3 = "result"))) || ((data.httpStatus === undefined) && (missing3 = "httpStatus"))) || ((data.undelivered === undefined) && (missing3 = "undelivered"))){validate233.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs11: any = errors;for(const key0 in data){if(!(((((key0 === "at") || (key0 === "result")) || (key0 === "cause")) || (key0 === "httpStatus")) || (key0 === "undelivered"))){validate233.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs11 === errors){if(data.at !== undefined){let data1: any = data.at;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data1 === "string"){if(!pattern5.test(data1)){validate233.errors = [{instancePath:instancePath+"/at",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate233.errors = [{instancePath:instancePath+"/at",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs12 === errors;}else {var valid3: any = true;}if(valid3){if(data.result !== undefined){let data2: any = data.result;const _errs15: any = errors;if(typeof data2 !== "string"){validate233.errors = [{instancePath:instancePath+"/result",schemaPath:"#/$defs/AttentionDeliveryResult/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((data2 === "delivered") || (data2 === "refused")) || (data2 === "unreachable")) || (data2 === "timedOut")) || (data2 === "signInRefused")) || (data2 === "notEncrypted")) || (data2 === "storeUnavailable"))){validate233.errors = [{instancePath:instancePath+"/result",schemaPath:"#/$defs/AttentionDeliveryResult/enum",keyword:"enum",params:{allowedValues: schema437.enum}}];return false;}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.cause !== undefined){let data3: any = data.cause;const _errs18: any = errors;if(typeof data3 !== "string"){validate233.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/AttentionDeliveryStoreUnavailableCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data3 === "locked") || (data3 === "unavailable")) || (data3 === "secretMissing")) || (data3 === "secretDamaged"))){validate233.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/AttentionDeliveryStoreUnavailableCause/enum",keyword:"enum",params:{allowedValues: schema438.enum}}];return false;}var valid3: any = _errs18 === errors;}else {var valid3: any = true;}if(valid3){if(data.httpStatus !== undefined){let data4: any = data.httpStatus;const _errs21: any = errors;if((!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))) && (data4 !== null)){validate233.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/type",keyword:"type",params:{type: schema435.properties.httpStatus.type}}];return false;}if(errors === _errs21){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 599 || isNaN(data4)){validate233.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/maximum",keyword:"maximum",params:{comparison: "<=", limit: 599}}];return false;}else {if(data4 < 100 || isNaN(data4)){validate233.errors = [{instancePath:instancePath+"/httpStatus",schemaPath:"#/properties/httpStatus/minimum",keyword:"minimum",params:{comparison: ">=", limit: 100}}];return false;}}}}var valid3: any = _errs21 === errors;}else {var valid3: any = true;}if(valid3){if(data.undelivered !== undefined){let data5: any = data.undelivered;const _errs23: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate233.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs23){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate233.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate233.errors = [{instancePath:instancePath+"/undelivered",schemaPath:"#/properties/undelivered/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid3: any = _errs23 === errors;}else {var valid3: any = true;}}}}}}}}else {validate233.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate233.errors = vErrors;return errors === 0;}
// prettier-ignore
validate233.errors = null as any[] | null;
// prettier-ignore
validate233.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate232(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate232.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.saved === undefined) && (missing0 = "saved")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.saved !== undefined){if(false !== data.saved){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}else {const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs5: any = errors;if(errors === _errs5){if(data && typeof data == "object" && !Array.isArray(data)){if(data.host !== undefined){if(data.host !== null){validate232.errors = [{instancePath:instancePath+"/host",schemaPath:"#/then/properties/host/type",keyword:"type",params:{type: "null"}}];return false;}}}else {validate232.errors = [{instancePath,schemaPath:"#/then/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs5 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.host = true;props0.saved = true;}ifClause0 = "then";}else {const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){if(data.host !== undefined){if(typeof data.host !== "string"){validate232.errors = [{instancePath:instancePath+"/host",schemaPath:"#/else/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}}else {validate232.errors = [{instancePath,schemaPath:"#/else/type",keyword:"type",params:{type: "object"}}];return false;}}var _valid0: any = _errs9 === errors;valid0 = _valid0;if(valid0){if(props0 !== true){props0 = props0 || {};props0.host = true;}}ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate232.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.saved === undefined) && (missing1 = "saved")) || ((data.host === undefined) && (missing1 = "host"))) || ((data.lastOutcome === undefined) && (missing1 = "lastOutcome"))){validate232.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs13: any = errors;for(const key0 in data){if(!(((key0 === "saved") || (key0 === "host")) || (key0 === "lastOutcome"))){validate232.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs13 === errors){if(data.saved !== undefined){const _errs14: any = errors;if(typeof data.saved !== "boolean"){validate232.errors = [{instancePath:instancePath+"/saved",schemaPath:"#/properties/saved/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}if(valid4){if(data.host !== undefined){let data4: any = data.host;const _errs16: any = errors;if((typeof data4 !== "string") && (data4 !== null)){validate232.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: schema434.properties.host.type}}];return false;}if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) < 1){validate232.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.lastOutcome !== undefined){let data5: any = data.lastOutcome;const _errs18: any = errors;const _errs19: any = errors;let valid5: any = false;const _errs20: any = errors;if(!(validate233.call(this, data5, {instancePath:instancePath+"/lastOutcome",parentData:data,parentDataProperty:"lastOutcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate233.errors : vErrors.concat(validate233.errors);errors = vErrors.length;}var _valid1: any = _errs20 === errors;valid5 = valid5 || _valid1;const _errs21: any = errors;if(data5 !== null){const err4: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}var _valid1: any = _errs21 === errors;valid5 = valid5 || _valid1;if(!valid5){const err5: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate232.errors = vErrors;return false;}else {errors = _errs19;if(vErrors !== null){if(_errs19){vErrors.length = _errs19;}else {vErrors = null;}}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}}}}}}else {validate232.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate232.errors = vErrors;return errors === 0;}
// prettier-ignore
validate232.errors = null as any[] | null;
// prettier-ignore
validate232.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate236(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate236.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.passwordSaved === undefined) && (missing0 = "passwordSaved")) || ((data.lastOutcome === undefined) && (missing0 = "lastOutcome"))){validate236.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "passwordSaved") || (key0 === "lastOutcome"))){validate236.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.passwordSaved !== undefined){const _errs2: any = errors;if(typeof data.passwordSaved !== "boolean"){validate236.errors = [{instancePath:instancePath+"/passwordSaved",schemaPath:"#/properties/passwordSaved/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastOutcome !== undefined){let data1: any = data.lastOutcome;const _errs4: any = errors;const _errs5: any = errors;let valid1: any = false;const _errs6: any = errors;if(!(validate233.call(this, data1, {instancePath:instancePath+"/lastOutcome",parentData:data,parentDataProperty:"lastOutcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate233.errors : vErrors.concat(validate233.errors);errors = vErrors.length;}var _valid0: any = _errs6 === errors;valid1 = valid1 || _valid0;const _errs7: any = errors;if(data1 !== null){const err0: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs7 === errors;valid1 = valid1 || _valid0;if(!valid1){const err1: any = {instancePath:instancePath+"/lastOutcome",schemaPath:"#/properties/lastOutcome/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;validate236.errors = vErrors;return false;}else {errors = _errs5;if(vErrors !== null){if(_errs5){vErrors.length = _errs5;}else {vErrors = null;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate236.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate236.errors = vErrors;return errors === 0;}
// prettier-ignore
validate236.errors = null as any[] | null;
// prettier-ignore
validate236.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate231(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate231.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.webAddress === undefined) && (missing0 = "webAddress")) || ((data.emailDigest === undefined) && (missing0 = "emailDigest"))){validate231.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "webAddress") || (key0 === "emailDigest"))){validate231.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.webAddress !== undefined){const _errs2: any = errors;if(!(validate232.call(this, data.webAddress, {instancePath:instancePath+"/webAddress",parentData:data,parentDataProperty:"webAddress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate232.errors : vErrors.concat(validate232.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.emailDigest !== undefined){const _errs3: any = errors;if(!(validate236.call(this, data.emailDigest, {instancePath:instancePath+"/emailDigest",parentData:data,parentDataProperty:"emailDigest",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate236.errors : vErrors.concat(validate236.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validate231.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate231.errors = vErrors;return errors === 0;}
// prettier-ignore
validate231.errors = null as any[] | null;
// prettier-ignore
validate231.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema441: any = {"description":"What a channel asked to test is missing: the web address, or the mail password.","type":"string","enum":["address","password"]};
// prettier-ignore
function validate239(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryNotConfiguredDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate239.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.missing === undefined) && (missing0 = "missing")){validate239.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "missing")){validate239.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.missing !== undefined){let data0: any = data.missing;if(typeof data0 !== "string"){validate239.errors = [{instancePath:instancePath+"/missing",schemaPath:"#/$defs/AttentionDeliveryMissing/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "address") || (data0 === "password"))){validate239.errors = [{instancePath:instancePath+"/missing",schemaPath:"#/$defs/AttentionDeliveryMissing/enum",keyword:"enum",params:{allowedValues: schema441.enum}}];return false;}}}}}else {validate239.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate239.errors = vErrors;return errors === 0;}
// prettier-ignore
validate239.errors = null as any[] | null;
// prettier-ignore
validate239.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema444: any = {"description":"Why this machine's keychain could not be used: it is `locked`, or it cannot be used now or at\nall (`unavailable`). A secret that cannot be sealed is refused and stored nowhere else.","type":"string","enum":["locked","unavailable"]};
// prettier-ignore
function validate240(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryStoreUnavailableDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate240.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.cause === undefined) && (missing0 = "cause")){validate240.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "cause")){validate240.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cause !== undefined){let data0: any = data.cause;if(typeof data0 !== "string"){validate240.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "locked") || (data0 === "unavailable"))){validate240.errors = [{instancePath:instancePath+"/cause",schemaPath:"sidekicks-contracts:keychain#/$defs/KeychainRefusalCause/enum",keyword:"enum",params:{allowedValues: schema444.enum}}];return false;}}}}}else {validate240.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate240.errors = vErrors;return errors === 0;}
// prettier-ignore
validate240.errors = null as any[] | null;
// prettier-ignore
validate240.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema446: any = {"description":"The two ways a moment leaves the machine.","type":"string","enum":["webAddress","emailDigest"]};
// prettier-ignore
function validate242(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryTestRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate242.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.channel === undefined) && (missing0 = "channel")){validate242.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "channel")){validate242.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.channel !== undefined){let data0: any = data.channel;if(typeof data0 !== "string"){validate242.errors = [{instancePath:instancePath+"/channel",schemaPath:"#/$defs/AttentionDeliveryChannel/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "webAddress") || (data0 === "emailDigest"))){validate242.errors = [{instancePath:instancePath+"/channel",schemaPath:"#/$defs/AttentionDeliveryChannel/enum",keyword:"enum",params:{allowedValues: schema446.enum}}];return false;}}}}}else {validate242.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate242.errors = vErrors;return errors === 0;}
// prettier-ignore
validate242.errors = null as any[] | null;
// prettier-ignore
validate242.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate243(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionDeliveryTestResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate243.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.outcome === undefined) && (missing0 = "outcome")){validate243.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "outcome")){validate243.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.outcome !== undefined){if(!(validate233.call(this, data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate233.errors : vErrors.concat(validate233.errors);errors = vErrors.length;}}}}}else {validate243.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate243.errors = vErrors;return errors === 0;}
// prettier-ignore
validate243.errors = null as any[] | null;
// prettier-ignore
validate243.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema448: any = {"anyOf":[{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The session or run and the state it is in, so a later state replaces the\noperating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,\n`plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its\nentry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and\nexecution index. A provider's build, also its entry's id, is `providerBuild:` and 32\nhex digits of the BLAKE3 hash of the provider and the build. The daemon mints each\nform within the 64 bytes a banner's tag and a push's collapse id hold."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The run, on a run-scoped entry."},"trigger":{"$ref":"#/$defs/AttentionMomentTrigger","description":"What raised it."},"severity":{"$ref":"#/$defs/AttentionSeverity","description":"Whether it blocks on the person."},"stepId":{"not":{},"tsType":"never","description":"Never present: only a Notify step's entry names a step."},"displayName":{"type":"string","minLength":1,"description":"The name the entry leads with."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice."},"sourceEventId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The canonical event that triggered the entry."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the entry was made."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Set once the state that produced the entry resolves; absent means outstanding."},"bannerState":{"$ref":"#/$defs/AttentionBannerState","description":"What became of its banner; absent until the daemon decides it, and main posts only\n`pending`."},"webAddressState":{"$ref":"#/$defs/AttentionWebAddressState","description":"Where its message to the web address stands; present exactly when it is sent there."},"webAddressAttemptCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many sends it took; present exactly with `webAddressState`."},"seen":{"type":"boolean","description":"The one seen-or-unseen fact the daemon keeps, which the session's row reads too."}},"required":["id","momentId","sessionId","trigger","severity","displayName","stateWord","sourceEventId","createdAt","seen"],"description":"A run's or session's own moment.","dependentRequired":{"webAddressState":["webAddressAttemptCount"],"webAddressAttemptCount":["webAddressState"]}},{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The session or run and the state it is in, so a later state replaces the\noperating-system banner in place: `run:<runId>`, `workflowRun:<workflowRunId>`,\n`plan:<planId>` or `session:<sessionId>`, and for a Notify step, which is also its\nentry's id, `notify:` and 32 hex digits of the BLAKE3 hash of its run, node and\nexecution index. A provider's build, also its entry's id, is `providerBuild:` and 32\nhex digits of the BLAKE3 hash of the provider and the build. The daemon mints each\nform within the 64 bytes a banner's tag and a push's collapse id hold."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"runId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The run."},"trigger":{"description":"Always `workflowNotify`.","type":"string","enum":["workflowNotify"]},"severity":{"description":"Always `informational`.","type":"string","enum":["informational"]},"stepId":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId","description":"The Notify node."},"displayName":{"type":"string","minLength":1,"description":"The name the entry leads with."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `Waiting on you`, `Finished`, `Failed`, or a notice."},"sourceEventId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The canonical event that triggered the entry."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the entry was made."},"resolvedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Set once the state that produced the entry resolves; absent means outstanding."},"bannerState":{"$ref":"#/$defs/AttentionBannerState","description":"What became of its banner; absent until the daemon decides it, and main posts only\n`pending`."},"webAddressState":{"$ref":"#/$defs/AttentionWebAddressState","description":"Where its message to the web address stands; present exactly when it is sent there."},"webAddressAttemptCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How many sends it took; present exactly with `webAddressState`."},"seen":{"type":"boolean","description":"The one seen-or-unseen fact the daemon keeps, which the session's row reads too."}},"required":["id","momentId","sessionId","runId","trigger","severity","stepId","displayName","stateWord","sourceEventId","createdAt","seen"],"description":"A workflow's Notify step.","dependentRequired":{"webAddressState":["webAddressAttemptCount"],"webAddressAttemptCount":["webAddressState"]}},{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The entry, the same as its moment id."},"momentId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"`providerBuild:` and 32 hex digits of the BLAKE3 hash of the provider and the build."},"trigger":{"description":"Always `providerBuild`.","type":"string","enum":["providerBuild"]},"severity":{"description":"Always `informational`.","type":"string","enum":["informational"]},"displayName":{"type":"string","minLength":1,"description":"The provider's name."},"stateWord":{"type":"string","minLength":1,"description":"What follows the name: `updated · <from> → <to>`, or `<to> available`."},"providerBuild":{"$ref":"#/$defs/AttentionProviderBuild","description":"The build."},"createdAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the build was recorded."},"bannerState":{"description":"Always `withheld`: no banner is raised for it.","type":"string","enum":["withheld"]}},"required":["id","momentId","trigger","severity","displayName","stateWord","providerBuild","createdAt","bannerState"],"description":"A provider's new build, which belongs to no session; last, so a session's entry never\nreads as it."}],"description":"One attention entry."};
// prettier-ignore
const schema450: any = {"description":"The triggers of a run's or session's own moment: every trigger but a Notify step's.","type":"string","enum":["pendingApproval","pendingInput","runCompleted","runFailed"]};
// prettier-ignore
const schema451: any = {"description":"The two severities: `actionable` attention blocks on the person, `informational` does not. A\nclient renders the two differently.","type":"string","enum":["actionable","informational"]};
// prettier-ignore
const schema454: any = {"description":"What became of an entry's operating-system banner, absent until the daemon decides it. The\ndaemon writes `withheld` when a switch or a mute keeps the entry from raising one, and `pending`\notherwise; main posts only a `pending` entry and settles it once, so no banner is posted twice.","type":"string","enum":["pending","posted","withheld","withdrawn"]};
// prettier-ignore
const schema455: any = {"description":"Where an entry's message to the person's web address stands.","type":"string","enum":["pending","delivered","undelivered"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
const formats0 = SCHEMA_FORMATS["https-url"];
// prettier-ignore
function validate246(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate246.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.provider === undefined) && (missing0 = "provider")) || ((data.toVersion === undefined) && (missing0 = "toVersion"))){validate246.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "provider") || (key0 === "fromVersion")) || (key0 === "toVersion")) || (key0 === "releaseNotesAddress"))){validate246.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate246.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate246.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.fromVersion !== undefined){let data1: any = data.fromVersion;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate246.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate246.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate246.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate246.errors = [{instancePath:instancePath+"/fromVersion",schemaPath:"#/properties/fromVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.toVersion !== undefined){let data2: any = data.toVersion;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate246.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate246.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate246.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate246.errors = [{instancePath:instancePath+"/toVersion",schemaPath:"#/properties/toVersion/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.releaseNotesAddress !== undefined){let data3: any = data.releaseNotesAddress;const _errs10: any = errors;if(errors === _errs10){if(errors === _errs10){if(typeof data3 === "string"){if(!pattern43.test(data3)){validate246.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}else {if(!(formats0(data3))){validate246.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/format",keyword:"format",params:{format: "https-url"}}];return false;}}}else {validate246.errors = [{instancePath:instancePath+"/releaseNotesAddress",schemaPath:"#/properties/releaseNotesAddress/type",keyword:"type",params:{type: "string"}}];return false;}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.fromVersion !== undefined && ((data.releaseNotesAddress === undefined) && (missing1 = "releaseNotesAddress"))){validate246.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "fromVersion",
    missingProperty: missing1,
    depsCount: 1,
    deps: "releaseNotesAddress"}}];return false;}else {if(data.releaseNotesAddress !== undefined && ((data.fromVersion === undefined) && (missing1 = "fromVersion"))){validate246.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "releaseNotesAddress",
    missingProperty: missing1,
    depsCount: 1,
    deps: "fromVersion"}}];return false;}}}}}}}}}else {validate246.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate246.errors = vErrors;return errors === 0;}
// prettier-ignore
validate246.errors = null as any[] | null;
// prettier-ignore
validate246.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate245(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionItem {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate245.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.id === undefined) && (missing0 = "id")) || ((data.momentId === undefined) && (missing0 = "momentId"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.trigger === undefined) && (missing0 = "trigger"))) || ((data.severity === undefined) && (missing0 = "severity"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.stateWord === undefined) && (missing0 = "stateWord"))) || ((data.sourceEventId === undefined) && (missing0 = "sourceEventId"))) || ((data.createdAt === undefined) && (missing0 = "createdAt"))) || ((data.seen === undefined) && (missing0 = "seen"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!(func2.call(schema448.anyOf[0].properties, key0))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs4: any = errors;if(errors === _errs4){if(typeof data0 === "string"){if(func1(data0) > 256){const err2: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(func1(data0) < 1){const err3: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}else {if(!pattern6.test(data0)){const err4: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}}}else {const err5: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/0/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.momentId !== undefined){let data1: any = data.momentId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){const err6: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}else {if(func1(data1) < 1){const err7: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {if(!pattern6.test(data1)){const err8: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}}}else {const err9: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/0/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.sessionId !== undefined){let data2: any = data.sessionId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern4.test(data2)){const err10: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}else {const err11: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}if(valid1){if(data.runId !== undefined){let data3: any = data.runId;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 256){const err12: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;}else {if(func1(data3) < 1){const err13: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}else {if(!pattern6.test(data3)){const err14: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}}}else {const err15: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/0/properties/runId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var valid1: any = _errs12 === errors;}else {var valid1: any = true;}if(valid1){if(data.trigger !== undefined){let data4: any = data.trigger;const _errs14: any = errors;if(typeof data4 !== "string"){const err16: any = {instancePath:instancePath+"/trigger",schemaPath:"#/$defs/AttentionMomentTrigger/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;}if(!((((data4 === "pendingApproval") || (data4 === "pendingInput")) || (data4 === "runCompleted")) || (data4 === "runFailed"))){const err17: any = {instancePath:instancePath+"/trigger",schemaPath:"#/$defs/AttentionMomentTrigger/enum",keyword:"enum",params:{allowedValues: schema450.enum}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}var valid1: any = _errs14 === errors;}else {var valid1: any = true;}if(valid1){if(data.severity !== undefined){let data5: any = data.severity;const _errs17: any = errors;if(typeof data5 !== "string"){const err18: any = {instancePath:instancePath+"/severity",schemaPath:"#/$defs/AttentionSeverity/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;}if(!((data5 === "actionable") || (data5 === "informational"))){const err19: any = {instancePath:instancePath+"/severity",schemaPath:"#/$defs/AttentionSeverity/enum",keyword:"enum",params:{allowedValues: schema451.enum}};if(vErrors === null){vErrors = [err19];}else {vErrors.push(err19);}errors++;}var valid1: any = _errs17 === errors;}else {var valid1: any = true;}if(valid1){if(data.stepId !== undefined){const _errs20: any = errors;const err20: any = {instancePath:instancePath+"/stepId",schemaPath:"#/anyOf/0/properties/stepId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err20];}else {vErrors.push(err20);}errors++;var valid1: any = _errs20 === errors;}else {var valid1: any = true;}if(valid1){if(data.displayName !== undefined){let data7: any = data.displayName;const _errs23: any = errors;if(errors === _errs23){if(typeof data7 === "string"){if(func1(data7) < 1){const err21: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/0/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err21];}else {vErrors.push(err21);}errors++;}}else {const err22: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/0/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err22];}else {vErrors.push(err22);}errors++;}}var valid1: any = _errs23 === errors;}else {var valid1: any = true;}if(valid1){if(data.stateWord !== undefined){let data8: any = data.stateWord;const _errs25: any = errors;if(errors === _errs25){if(typeof data8 === "string"){if(func1(data8) < 1){const err23: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/0/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err23];}else {vErrors.push(err23);}errors++;}}else {const err24: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/0/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err24];}else {vErrors.push(err24);}errors++;}}var valid1: any = _errs25 === errors;}else {var valid1: any = true;}if(valid1){if(data.sourceEventId !== undefined){let data9: any = data.sourceEventId;const _errs27: any = errors;if(errors === _errs27){if(typeof data9 === "string"){if(func1(data9) > 256){const err25: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err25];}else {vErrors.push(err25);}errors++;}else {if(func1(data9) < 1){const err26: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err26];}else {vErrors.push(err26);}errors++;}else {if(!pattern6.test(data9)){const err27: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err27];}else {vErrors.push(err27);}errors++;}}}}else {const err28: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/0/properties/sourceEventId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err28];}else {vErrors.push(err28);}errors++;}}var valid1: any = _errs27 === errors;}else {var valid1: any = true;}if(valid1){if(data.createdAt !== undefined){let data10: any = data.createdAt;const _errs29: any = errors;const _errs30: any = errors;if(errors === _errs30){if(typeof data10 === "string"){if(!pattern5.test(data10)){const err29: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}};if(vErrors === null){vErrors = [err29];}else {vErrors.push(err29);}errors++;}}else {const err30: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err30];}else {vErrors.push(err30);}errors++;}}var valid1: any = _errs29 === errors;}else {var valid1: any = true;}if(valid1){if(data.resolvedAt !== undefined){let data11: any = data.resolvedAt;const _errs32: any = errors;const _errs33: any = errors;if(errors === _errs33){if(typeof data11 === "string"){if(!pattern5.test(data11)){const err31: any = {instancePath:instancePath+"/resolvedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}};if(vErrors === null){vErrors = [err31];}else {vErrors.push(err31);}errors++;}}else {const err32: any = {instancePath:instancePath+"/resolvedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err32];}else {vErrors.push(err32);}errors++;}}var valid1: any = _errs32 === errors;}else {var valid1: any = true;}if(valid1){if(data.bannerState !== undefined){let data12: any = data.bannerState;const _errs35: any = errors;if(typeof data12 !== "string"){const err33: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/$defs/AttentionBannerState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err33];}else {vErrors.push(err33);}errors++;}if(!((((data12 === "pending") || (data12 === "posted")) || (data12 === "withheld")) || (data12 === "withdrawn"))){const err34: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/$defs/AttentionBannerState/enum",keyword:"enum",params:{allowedValues: schema454.enum}};if(vErrors === null){vErrors = [err34];}else {vErrors.push(err34);}errors++;}var valid1: any = _errs35 === errors;}else {var valid1: any = true;}if(valid1){if(data.webAddressState !== undefined){let data13: any = data.webAddressState;const _errs38: any = errors;if(typeof data13 !== "string"){const err35: any = {instancePath:instancePath+"/webAddressState",schemaPath:"#/$defs/AttentionWebAddressState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err35];}else {vErrors.push(err35);}errors++;}if(!(((data13 === "pending") || (data13 === "delivered")) || (data13 === "undelivered"))){const err36: any = {instancePath:instancePath+"/webAddressState",schemaPath:"#/$defs/AttentionWebAddressState/enum",keyword:"enum",params:{allowedValues: schema455.enum}};if(vErrors === null){vErrors = [err36];}else {vErrors.push(err36);}errors++;}var valid1: any = _errs38 === errors;}else {var valid1: any = true;}if(valid1){if(data.webAddressAttemptCount !== undefined){let data14: any = data.webAddressAttemptCount;const _errs41: any = errors;if(!(((typeof data14 == "number") && (!(data14 % 1) && !isNaN(data14))) && (isFinite(data14)))){const err37: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err37];}else {vErrors.push(err37);}errors++;}if(errors === _errs41){if((typeof data14 == "number") && (isFinite(data14))){if(data14 > 9007199254740991 || isNaN(data14)){const err38: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err38];}else {vErrors.push(err38);}errors++;}else {if(data14 < 0 || isNaN(data14)){const err39: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/0/properties/webAddressAttemptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err39];}else {vErrors.push(err39);}errors++;}}}}var valid1: any = _errs41 === errors;}else {var valid1: any = true;}if(valid1){if(data.seen !== undefined){const _errs43: any = errors;if(typeof data.seen !== "boolean"){const err40: any = {instancePath:instancePath+"/seen",schemaPath:"#/anyOf/0/properties/seen/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err40];}else {vErrors.push(err40);}errors++;}var valid1: any = _errs43 === errors;}else {var valid1: any = true;}if(valid1){let missing1: any;if(data.webAddressState !== undefined && ((data.webAddressAttemptCount === undefined) && (missing1 = "webAddressAttemptCount"))){const err41: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressState",
    missingProperty: missing1,
    depsCount: 1,
    deps: "webAddressAttemptCount"}};if(vErrors === null){vErrors = [err41];}else {vErrors.push(err41);}errors++;}else {if(data.webAddressAttemptCount !== undefined && ((data.webAddressState === undefined) && (missing1 = "webAddressState"))){const err42: any = {instancePath,schemaPath:"#/anyOf/0/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressAttemptCount",
    missingProperty: missing1,
    depsCount: 1,
    deps: "webAddressState"}};if(vErrors === null){vErrors = [err42];}else {vErrors.push(err42);}errors++;}}}}}}}}}}}}}}}}}}}}}else {const err43: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err43];}else {vErrors.push(err43);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs45: any = errors;if(errors === _errs45){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((((((((data.id === undefined) && (missing2 = "id")) || ((data.momentId === undefined) && (missing2 = "momentId"))) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.runId === undefined) && (missing2 = "runId"))) || ((data.trigger === undefined) && (missing2 = "trigger"))) || ((data.severity === undefined) && (missing2 = "severity"))) || ((data.stepId === undefined) && (missing2 = "stepId"))) || ((data.displayName === undefined) && (missing2 = "displayName"))) || ((data.stateWord === undefined) && (missing2 = "stateWord"))) || ((data.sourceEventId === undefined) && (missing2 = "sourceEventId"))) || ((data.createdAt === undefined) && (missing2 = "createdAt"))) || ((data.seen === undefined) && (missing2 = "seen"))){const err44: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err44];}else {vErrors.push(err44);}errors++;}else {const _errs47: any = errors;for(const key1 in data){if(!(func2.call(schema448.anyOf[1].properties, key1))){const err45: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err45];}else {vErrors.push(err45);}errors++;break;}}if(_errs47 === errors){if(data.id !== undefined){let data16: any = data.id;const _errs48: any = errors;if(errors === _errs48){if(typeof data16 === "string"){if(func1(data16) > 256){const err46: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err46];}else {vErrors.push(err46);}errors++;}else {if(func1(data16) < 1){const err47: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err47];}else {vErrors.push(err47);}errors++;}else {if(!pattern6.test(data16)){const err48: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err48];}else {vErrors.push(err48);}errors++;}}}}else {const err49: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/1/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err49];}else {vErrors.push(err49);}errors++;}}var valid9: any = _errs48 === errors;}else {var valid9: any = true;}if(valid9){if(data.momentId !== undefined){let data17: any = data.momentId;const _errs50: any = errors;if(errors === _errs50){if(typeof data17 === "string"){if(func1(data17) > 256){const err50: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err50];}else {vErrors.push(err50);}errors++;}else {if(func1(data17) < 1){const err51: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err51];}else {vErrors.push(err51);}errors++;}else {if(!pattern6.test(data17)){const err52: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err52];}else {vErrors.push(err52);}errors++;}}}}else {const err53: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/1/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err53];}else {vErrors.push(err53);}errors++;}}var valid9: any = _errs50 === errors;}else {var valid9: any = true;}if(valid9){if(data.sessionId !== undefined){let data18: any = data.sessionId;const _errs52: any = errors;const _errs53: any = errors;if(errors === _errs53){if(typeof data18 === "string"){if(!pattern4.test(data18)){const err54: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err54];}else {vErrors.push(err54);}errors++;}}else {const err55: any = {instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err55];}else {vErrors.push(err55);}errors++;}}var valid9: any = _errs52 === errors;}else {var valid9: any = true;}if(valid9){if(data.runId !== undefined){let data19: any = data.runId;const _errs56: any = errors;if(errors === _errs56){if(typeof data19 === "string"){if(func1(data19) > 256){const err56: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err56];}else {vErrors.push(err56);}errors++;}else {if(func1(data19) < 1){const err57: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err57];}else {vErrors.push(err57);}errors++;}else {if(!pattern6.test(data19)){const err58: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err58];}else {vErrors.push(err58);}errors++;}}}}else {const err59: any = {instancePath:instancePath+"/runId",schemaPath:"#/anyOf/1/properties/runId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err59];}else {vErrors.push(err59);}errors++;}}var valid9: any = _errs56 === errors;}else {var valid9: any = true;}if(valid9){if(data.trigger !== undefined){let data20: any = data.trigger;const _errs58: any = errors;if(typeof data20 !== "string"){const err60: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/1/properties/trigger/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err60];}else {vErrors.push(err60);}errors++;}if(!(data20 === "workflowNotify")){const err61: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/1/properties/trigger/enum",keyword:"enum",params:{allowedValues: schema448.anyOf[1].properties.trigger.enum}};if(vErrors === null){vErrors = [err61];}else {vErrors.push(err61);}errors++;}var valid9: any = _errs58 === errors;}else {var valid9: any = true;}if(valid9){if(data.severity !== undefined){let data21: any = data.severity;const _errs60: any = errors;if(typeof data21 !== "string"){const err62: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/1/properties/severity/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err62];}else {vErrors.push(err62);}errors++;}if(!(data21 === "informational")){const err63: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/1/properties/severity/enum",keyword:"enum",params:{allowedValues: schema448.anyOf[1].properties.severity.enum}};if(vErrors === null){vErrors = [err63];}else {vErrors.push(err63);}errors++;}var valid9: any = _errs60 === errors;}else {var valid9: any = true;}if(valid9){if(data.stepId !== undefined){let data22: any = data.stepId;const _errs62: any = errors;const _errs63: any = errors;if(errors === _errs63){if(typeof data22 === "string"){if(func1(data22) < 1){const err64: any = {instancePath:instancePath+"/stepId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err64];}else {vErrors.push(err64);}errors++;}}else {const err65: any = {instancePath:instancePath+"/stepId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err65];}else {vErrors.push(err65);}errors++;}}var valid9: any = _errs62 === errors;}else {var valid9: any = true;}if(valid9){if(data.displayName !== undefined){let data23: any = data.displayName;const _errs66: any = errors;if(errors === _errs66){if(typeof data23 === "string"){if(func1(data23) < 1){const err66: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/1/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err66];}else {vErrors.push(err66);}errors++;}}else {const err67: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/1/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err67];}else {vErrors.push(err67);}errors++;}}var valid9: any = _errs66 === errors;}else {var valid9: any = true;}if(valid9){if(data.stateWord !== undefined){let data24: any = data.stateWord;const _errs68: any = errors;if(errors === _errs68){if(typeof data24 === "string"){if(func1(data24) < 1){const err68: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/1/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err68];}else {vErrors.push(err68);}errors++;}}else {const err69: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/1/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err69];}else {vErrors.push(err69);}errors++;}}var valid9: any = _errs68 === errors;}else {var valid9: any = true;}if(valid9){if(data.sourceEventId !== undefined){let data25: any = data.sourceEventId;const _errs70: any = errors;if(errors === _errs70){if(typeof data25 === "string"){if(func1(data25) > 256){const err70: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err70];}else {vErrors.push(err70);}errors++;}else {if(func1(data25) < 1){const err71: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err71];}else {vErrors.push(err71);}errors++;}else {if(!pattern6.test(data25)){const err72: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err72];}else {vErrors.push(err72);}errors++;}}}}else {const err73: any = {instancePath:instancePath+"/sourceEventId",schemaPath:"#/anyOf/1/properties/sourceEventId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err73];}else {vErrors.push(err73);}errors++;}}var valid9: any = _errs70 === errors;}else {var valid9: any = true;}if(valid9){if(data.createdAt !== undefined){let data26: any = data.createdAt;const _errs72: any = errors;const _errs73: any = errors;if(errors === _errs73){if(typeof data26 === "string"){if(!pattern5.test(data26)){const err74: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}};if(vErrors === null){vErrors = [err74];}else {vErrors.push(err74);}errors++;}}else {const err75: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err75];}else {vErrors.push(err75);}errors++;}}var valid9: any = _errs72 === errors;}else {var valid9: any = true;}if(valid9){if(data.resolvedAt !== undefined){let data27: any = data.resolvedAt;const _errs75: any = errors;const _errs76: any = errors;if(errors === _errs76){if(typeof data27 === "string"){if(!pattern5.test(data27)){const err76: any = {instancePath:instancePath+"/resolvedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}};if(vErrors === null){vErrors = [err76];}else {vErrors.push(err76);}errors++;}}else {const err77: any = {instancePath:instancePath+"/resolvedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err77];}else {vErrors.push(err77);}errors++;}}var valid9: any = _errs75 === errors;}else {var valid9: any = true;}if(valid9){if(data.bannerState !== undefined){let data28: any = data.bannerState;const _errs78: any = errors;if(typeof data28 !== "string"){const err78: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/$defs/AttentionBannerState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err78];}else {vErrors.push(err78);}errors++;}if(!((((data28 === "pending") || (data28 === "posted")) || (data28 === "withheld")) || (data28 === "withdrawn"))){const err79: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/$defs/AttentionBannerState/enum",keyword:"enum",params:{allowedValues: schema454.enum}};if(vErrors === null){vErrors = [err79];}else {vErrors.push(err79);}errors++;}var valid9: any = _errs78 === errors;}else {var valid9: any = true;}if(valid9){if(data.webAddressState !== undefined){let data29: any = data.webAddressState;const _errs81: any = errors;if(typeof data29 !== "string"){const err80: any = {instancePath:instancePath+"/webAddressState",schemaPath:"#/$defs/AttentionWebAddressState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err80];}else {vErrors.push(err80);}errors++;}if(!(((data29 === "pending") || (data29 === "delivered")) || (data29 === "undelivered"))){const err81: any = {instancePath:instancePath+"/webAddressState",schemaPath:"#/$defs/AttentionWebAddressState/enum",keyword:"enum",params:{allowedValues: schema455.enum}};if(vErrors === null){vErrors = [err81];}else {vErrors.push(err81);}errors++;}var valid9: any = _errs81 === errors;}else {var valid9: any = true;}if(valid9){if(data.webAddressAttemptCount !== undefined){let data30: any = data.webAddressAttemptCount;const _errs84: any = errors;if(!(((typeof data30 == "number") && (!(data30 % 1) && !isNaN(data30))) && (isFinite(data30)))){const err82: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/type",keyword:"type",params:{type: "integer"}};if(vErrors === null){vErrors = [err82];}else {vErrors.push(err82);}errors++;}if(errors === _errs84){if((typeof data30 == "number") && (isFinite(data30))){if(data30 > 9007199254740991 || isNaN(data30)){const err83: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}};if(vErrors === null){vErrors = [err83];}else {vErrors.push(err83);}errors++;}else {if(data30 < 0 || isNaN(data30)){const err84: any = {instancePath:instancePath+"/webAddressAttemptCount",schemaPath:"#/anyOf/1/properties/webAddressAttemptCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}};if(vErrors === null){vErrors = [err84];}else {vErrors.push(err84);}errors++;}}}}var valid9: any = _errs84 === errors;}else {var valid9: any = true;}if(valid9){if(data.seen !== undefined){const _errs86: any = errors;if(typeof data.seen !== "boolean"){const err85: any = {instancePath:instancePath+"/seen",schemaPath:"#/anyOf/1/properties/seen/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err85];}else {vErrors.push(err85);}errors++;}var valid9: any = _errs86 === errors;}else {var valid9: any = true;}if(valid9){let missing3: any;if(data.webAddressState !== undefined && ((data.webAddressAttemptCount === undefined) && (missing3 = "webAddressAttemptCount"))){const err86: any = {instancePath,schemaPath:"#/anyOf/1/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressState",
    missingProperty: missing3,
    depsCount: 1,
    deps: "webAddressAttemptCount"}};if(vErrors === null){vErrors = [err86];}else {vErrors.push(err86);}errors++;}else {if(data.webAddressAttemptCount !== undefined && ((data.webAddressState === undefined) && (missing3 = "webAddressState"))){const err87: any = {instancePath,schemaPath:"#/anyOf/1/dependentRequired",keyword:"dependentRequired",params:{property: "webAddressAttemptCount",
    missingProperty: missing3,
    depsCount: 1,
    deps: "webAddressState"}};if(vErrors === null){vErrors = [err87];}else {vErrors.push(err87);}errors++;}}}}}}}}}}}}}}}}}}}}}else {const err88: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err88];}else {vErrors.push(err88);}errors++;}}var _valid0: any = _errs45 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs88: any = errors;if(errors === _errs88){if(data && typeof data == "object" && !Array.isArray(data)){let missing4: any;if((((((((((data.id === undefined) && (missing4 = "id")) || ((data.momentId === undefined) && (missing4 = "momentId"))) || ((data.trigger === undefined) && (missing4 = "trigger"))) || ((data.severity === undefined) && (missing4 = "severity"))) || ((data.displayName === undefined) && (missing4 = "displayName"))) || ((data.stateWord === undefined) && (missing4 = "stateWord"))) || ((data.providerBuild === undefined) && (missing4 = "providerBuild"))) || ((data.createdAt === undefined) && (missing4 = "createdAt"))) || ((data.bannerState === undefined) && (missing4 = "bannerState"))){const err89: any = {instancePath,schemaPath:"#/anyOf/2/required",keyword:"required",params:{missingProperty: missing4}};if(vErrors === null){vErrors = [err89];}else {vErrors.push(err89);}errors++;}else {const _errs90: any = errors;for(const key2 in data){if(!(func2.call(schema448.anyOf[2].properties, key2))){const err90: any = {instancePath,schemaPath:"#/anyOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err90];}else {vErrors.push(err90);}errors++;break;}}if(_errs90 === errors){if(data.id !== undefined){let data32: any = data.id;const _errs91: any = errors;if(errors === _errs91){if(typeof data32 === "string"){if(func1(data32) > 256){const err91: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err91];}else {vErrors.push(err91);}errors++;}else {if(func1(data32) < 1){const err92: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err92];}else {vErrors.push(err92);}errors++;}else {if(!pattern6.test(data32)){const err93: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err93];}else {vErrors.push(err93);}errors++;}}}}else {const err94: any = {instancePath:instancePath+"/id",schemaPath:"#/anyOf/2/properties/id/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err94];}else {vErrors.push(err94);}errors++;}}var valid16: any = _errs91 === errors;}else {var valid16: any = true;}if(valid16){if(data.momentId !== undefined){let data33: any = data.momentId;const _errs93: any = errors;if(errors === _errs93){if(typeof data33 === "string"){if(func1(data33) > 256){const err95: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err95];}else {vErrors.push(err95);}errors++;}else {if(func1(data33) < 1){const err96: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err96];}else {vErrors.push(err96);}errors++;}else {if(!pattern6.test(data33)){const err97: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err97];}else {vErrors.push(err97);}errors++;}}}}else {const err98: any = {instancePath:instancePath+"/momentId",schemaPath:"#/anyOf/2/properties/momentId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err98];}else {vErrors.push(err98);}errors++;}}var valid16: any = _errs93 === errors;}else {var valid16: any = true;}if(valid16){if(data.trigger !== undefined){let data34: any = data.trigger;const _errs95: any = errors;if(typeof data34 !== "string"){const err99: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/2/properties/trigger/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err99];}else {vErrors.push(err99);}errors++;}if(!(data34 === "providerBuild")){const err100: any = {instancePath:instancePath+"/trigger",schemaPath:"#/anyOf/2/properties/trigger/enum",keyword:"enum",params:{allowedValues: schema448.anyOf[2].properties.trigger.enum}};if(vErrors === null){vErrors = [err100];}else {vErrors.push(err100);}errors++;}var valid16: any = _errs95 === errors;}else {var valid16: any = true;}if(valid16){if(data.severity !== undefined){let data35: any = data.severity;const _errs97: any = errors;if(typeof data35 !== "string"){const err101: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/2/properties/severity/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err101];}else {vErrors.push(err101);}errors++;}if(!(data35 === "informational")){const err102: any = {instancePath:instancePath+"/severity",schemaPath:"#/anyOf/2/properties/severity/enum",keyword:"enum",params:{allowedValues: schema448.anyOf[2].properties.severity.enum}};if(vErrors === null){vErrors = [err102];}else {vErrors.push(err102);}errors++;}var valid16: any = _errs97 === errors;}else {var valid16: any = true;}if(valid16){if(data.displayName !== undefined){let data36: any = data.displayName;const _errs99: any = errors;if(errors === _errs99){if(typeof data36 === "string"){if(func1(data36) < 1){const err103: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/2/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err103];}else {vErrors.push(err103);}errors++;}}else {const err104: any = {instancePath:instancePath+"/displayName",schemaPath:"#/anyOf/2/properties/displayName/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err104];}else {vErrors.push(err104);}errors++;}}var valid16: any = _errs99 === errors;}else {var valid16: any = true;}if(valid16){if(data.stateWord !== undefined){let data37: any = data.stateWord;const _errs101: any = errors;if(errors === _errs101){if(typeof data37 === "string"){if(func1(data37) < 1){const err105: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/2/properties/stateWord/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err105];}else {vErrors.push(err105);}errors++;}}else {const err106: any = {instancePath:instancePath+"/stateWord",schemaPath:"#/anyOf/2/properties/stateWord/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err106];}else {vErrors.push(err106);}errors++;}}var valid16: any = _errs101 === errors;}else {var valid16: any = true;}if(valid16){if(data.providerBuild !== undefined){const _errs103: any = errors;if(!(validate246.call(this, data.providerBuild, {instancePath:instancePath+"/providerBuild",parentData:data,parentDataProperty:"providerBuild",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate246.errors : vErrors.concat(validate246.errors);errors = vErrors.length;}var valid16: any = _errs103 === errors;}else {var valid16: any = true;}if(valid16){if(data.createdAt !== undefined){let data39: any = data.createdAt;const _errs104: any = errors;const _errs105: any = errors;if(errors === _errs105){if(typeof data39 === "string"){if(!pattern5.test(data39)){const err107: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}};if(vErrors === null){vErrors = [err107];}else {vErrors.push(err107);}errors++;}}else {const err108: any = {instancePath:instancePath+"/createdAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err108];}else {vErrors.push(err108);}errors++;}}var valid16: any = _errs104 === errors;}else {var valid16: any = true;}if(valid16){if(data.bannerState !== undefined){let data40: any = data.bannerState;const _errs107: any = errors;if(typeof data40 !== "string"){const err109: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/anyOf/2/properties/bannerState/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err109];}else {vErrors.push(err109);}errors++;}if(!(data40 === "withheld")){const err110: any = {instancePath:instancePath+"/bannerState",schemaPath:"#/anyOf/2/properties/bannerState/enum",keyword:"enum",params:{allowedValues: schema448.anyOf[2].properties.bannerState.enum}};if(vErrors === null){vErrors = [err110];}else {vErrors.push(err110);}errors++;}var valid16: any = _errs107 === errors;}else {var valid16: any = true;}}}}}}}}}}}}else {const err111: any = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err111];}else {vErrors.push(err111);}errors++;}}var _valid0: any = _errs88 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err112: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err112];}else {vErrors.push(err112);}errors++;validate245.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate245.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate245.errors = null as any[] | null;
// prettier-ignore
validate245.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
function validate248(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionMailPasswordUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate248.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.password === undefined) && (missing0 = "password")){validate248.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "password")){validate248.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.password !== undefined){let data0: any = data.password;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validate248.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validate248.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate248.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate248.errors = [{instancePath:instancePath+"/password",schemaPath:"#/properties/password/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate248.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate248.errors = vErrors;return errors === 0;}
// prettier-ignore
validate248.errors = null as any[] | null;
// prettier-ignore
validate248.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate249(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionProjection {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate249.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.items === undefined) && (missing0 = "items")){validate249.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "items")){validate249.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.items !== undefined){let data0: any = data.items;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate245.call(this, data0[i0], {instancePath:instancePath+"/items/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate245.errors : vErrors.concat(validate245.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate249.errors = [{instancePath:instancePath+"/items",schemaPath:"#/properties/items/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate249.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate249.errors = vErrors;return errors === 0;}
// prettier-ignore
validate249.errors = null as any[] | null;
// prettier-ignore
validate249.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate252(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate252.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.sessionId === undefined) && (missing0 = "sessionId")){validate252.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "runId"))){validate252.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate252.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate252.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate252.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate252.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:workflow/run/id#/$defs/WorkflowRunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate252.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate252.errors = vErrors;return errors === 0;}
// prettier-ignore
validate252.errors = null as any[] | null;
// prettier-ignore
validate252.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate251(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSeenUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate251.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.subject === undefined) && (missing0 = "subject")){validate251.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "subject")){validate251.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subject !== undefined){if(!(validate252.call(this, data.subject, {instancePath:instancePath+"/subject",parentData:data,parentDataProperty:"subject",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate252.errors : vErrors.concat(validate252.errors);errors = vErrors.length;}}}}}else {validate251.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate251.errors = vErrors;return errors === 0;}
// prettier-ignore
validate251.errors = null as any[] | null;
// prettier-ignore
validate251.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema473: any = {"description":"How far an `attention.subscribe` that names a session narrows the projection.","type":"string","enum":["run","session"]};
// prettier-ignore
function validate254(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionSubscribeRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate254.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs1: any = errors;let valid0: any = true;const _errs2: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.scope === undefined) && (missing0 = "scope")){const err0: any = {};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(data.scope !== undefined){if("run" !== data.scope){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}}var _valid0: any = _errs2 === errors;errors = _errs1;if(vErrors !== null){if(_errs1){vErrors.length = _errs1;}else {vErrors = null;}}let ifClause0: any;if(_valid0){const _errs4: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((data.runId === undefined) && (missing1 = "runId")){validate254.errors = [{instancePath,schemaPath:"#/then/required",keyword:"required",params:{missingProperty: missing1}}];return false;}}var _valid0: any = _errs4 === errors;valid0 = _valid0;if(valid0){var props0: any = {};props0.runId = true;props0.scope = true;}ifClause0 = "then";}else {const _errs5: any = errors;const _errs6: any = errors;const _errs7: any = errors;if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((data.runId === undefined) && (missing2 = "runId")){const err2: any = {};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var valid2: any = _errs7 === errors;if(valid2){validate254.errors = [{instancePath,schemaPath:"#/else/not",keyword:"not",params:{}}];return false;}else {errors = _errs6;if(vErrors !== null){if(_errs6){vErrors.length = _errs6;}else {vErrors = null;}}}var _valid0: any = _errs5 === errors;valid0 = _valid0;ifClause0 = "else";}if(!valid0){const err3: any = {instancePath,schemaPath:"#/if",keyword:"if",params:{failingKeyword: ifClause0}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate254.errors = vErrors;return false;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs8: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "scope")) || (key0 === "runId"))){validate254.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs8 === errors){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate254.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate254.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs9 === errors;}else {var valid3: any = true;}if(valid3){if(data.scope !== undefined){let data2: any = data.scope;const _errs13: any = errors;if(typeof data2 !== "string"){validate254.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/AttentionSubscribeScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "run") || (data2 === "session"))){validate254.errors = [{instancePath:instancePath+"/scope",schemaPath:"#/$defs/AttentionSubscribeScope/enum",keyword:"enum",params:{allowedValues: schema473.enum}}];return false;}var valid3: any = _errs13 === errors;}else {var valid3: any = true;}if(valid3){if(data.runId !== undefined){let data3: any = data.runId;const _errs16: any = errors;if(errors === _errs16){if(typeof data3 === "string"){if(func1(data3) > 256){validate254.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate254.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate254.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate254.errors = [{instancePath:instancePath+"/runId",schemaPath:"#/properties/runId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs16 === errors;}else {var valid3: any = true;}if(valid3){let missing3: any;if(data.scope !== undefined && ((data.sessionId === undefined) && (missing3 = "sessionId"))){validate254.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "scope",
    missingProperty: missing3,
    depsCount: 1,
    deps: "sessionId"}}];return false;}}}}}}else {validate254.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate254.errors = vErrors;return errors === 0;}
// prettier-ignore
validate254.errors = null as any[] | null;
// prettier-ignore
validate254.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate255(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressSecretRotateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate255.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.signingSecret === undefined) && (missing0 = "signingSecret")){validate255.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "signingSecret")){validate255.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.signingSecret !== undefined){let data0: any = data.signingSecret;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate255.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate255.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate255.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate255.errors = vErrors;return errors === 0;}
// prettier-ignore
validate255.errors = null as any[] | null;
// prettier-ignore
validate255.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate256(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate256.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.address === undefined) && (missing0 = "address")){validate256.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "address")){validate256.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.address !== undefined){let data0: any = data.address;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 8192){validate256.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/maxLength",keyword:"maxLength",params:{limit: 8192}}];return false;}else {if(func1(data0) < 1){validate256.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate256.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate256.errors = [{instancePath:instancePath+"/address",schemaPath:"#/properties/address/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate256.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate256.errors = vErrors;return errors === 0;}
// prettier-ignore
validate256.errors = null as any[] | null;
// prettier-ignore
validate256.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema476: any = {"type":"object","additionalProperties":false,"properties":{"host":{"type":"string","minLength":1,"description":"The saved address's scheme and host."},"signingSecret":{"type":["string","null"],"minLength":1,"description":"The signing secret, or `null`."}},"required":["host","signingSecret"],"description":"The saved address's scheme and host, and the signing secret the receiver checks each message\nwith: minted by the first save and shown this once, `null` on every later save."};
// prettier-ignore
function validate257(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AttentionWebAddressUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate257.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.host === undefined) && (missing0 = "host")) || ((data.signingSecret === undefined) && (missing0 = "signingSecret"))){validate257.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "host") || (key0 === "signingSecret"))){validate257.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.host !== undefined){let data0: any = data.host;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) < 1){validate257.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate257.errors = [{instancePath:instancePath+"/host",schemaPath:"#/properties/host/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.signingSecret !== undefined){let data1: any = data.signingSecret;const _errs4: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validate257.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/type",keyword:"type",params:{type: schema476.properties.signingSecret.type}}];return false;}if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validate257.errors = [{instancePath:instancePath+"/signingSecret",schemaPath:"#/properties/signingSecret/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validate257.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate257.errors = vErrors;return errors === 0;}
// prettier-ignore
validate257.errors = null as any[] | null;
// prettier-ignore
validate257.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AttentionBannerSettleRequest}. */
export const validateAttentionBannerSettleRequest: SchemaCheck<AttentionBannerSettleRequest> =
  validate230;
/** Checks that a value is a {@link AttentionDeliveryListResponse}. */
export const validateAttentionDeliveryListResponse: SchemaCheck<AttentionDeliveryListResponse> =
  validate231;
/** Checks that a value is a {@link AttentionDeliveryNotConfiguredDetails}. */
export const validateAttentionDeliveryNotConfiguredDetails: SchemaCheck<AttentionDeliveryNotConfiguredDetails> =
  validate239;
/** Checks that a value is a {@link AttentionDeliveryStoreUnavailableDetails}. */
export const validateAttentionDeliveryStoreUnavailableDetails: SchemaCheck<AttentionDeliveryStoreUnavailableDetails> =
  validate240;
/** Checks that a value is a {@link AttentionDeliveryTestRequest}. */
export const validateAttentionDeliveryTestRequest: SchemaCheck<AttentionDeliveryTestRequest> =
  validate242;
/** Checks that a value is a {@link AttentionDeliveryTestResponse}. */
export const validateAttentionDeliveryTestResponse: SchemaCheck<AttentionDeliveryTestResponse> =
  validate243;
/** Checks that a value is a {@link AttentionItem}. */
export const validateAttentionItem: SchemaCheck<AttentionItem> = validate245;
/** Checks that a value is a {@link AttentionMailPasswordUpdateRequest}. */
export const validateAttentionMailPasswordUpdateRequest: SchemaCheck<AttentionMailPasswordUpdateRequest> =
  validate248;
/** Checks that a value is a {@link AttentionProjection}. */
export const validateAttentionProjection: SchemaCheck<AttentionProjection> = validate249;
/** Checks that a value is a {@link AttentionSeenUpdateRequest}. */
export const validateAttentionSeenUpdateRequest: SchemaCheck<AttentionSeenUpdateRequest> =
  validate251;
/** Checks that a value is a {@link AttentionSubscribeRequest}. */
export const validateAttentionSubscribeRequest: SchemaCheck<AttentionSubscribeRequest> =
  validate254;
/** Checks that a value is a {@link AttentionWebAddressSecretRotateResponse}. */
export const validateAttentionWebAddressSecretRotateResponse: SchemaCheck<AttentionWebAddressSecretRotateResponse> =
  validate255;
/** Checks that a value is a {@link AttentionWebAddressUpdateRequest}. */
export const validateAttentionWebAddressUpdateRequest: SchemaCheck<AttentionWebAddressUpdateRequest> =
  validate256;
/** Checks that a value is a {@link AttentionWebAddressUpdateResponse}. */
export const validateAttentionWebAddressUpdateResponse: SchemaCheck<AttentionWebAddressUpdateResponse> =
  validate257;

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
