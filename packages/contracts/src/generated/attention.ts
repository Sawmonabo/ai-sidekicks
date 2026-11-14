// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The attention projection (machine-wide, whole on every emission) and the `attention.*` methods: banner settling, seen marking, and delivery beyond this machine.

import type { WireInstant } from "./internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "./jsonrpc/streaming.js";
import type { KeychainRefusalCause } from "./keychain.js";
import type { EmptyPayload } from "./method-descriptor.js";
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

/** The methods of {@link ATTENTION_METHOD_DESCRIPTORS}, each with its kind. */
export interface AttentionMethodDescriptors {
  readonly "attention.subscribe": {
    readonly method: "attention.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "attention.banner.settle": {
    readonly method: "attention.banner.settle";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.seen.update": {
    readonly method: "attention.seen.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.delivery.list": {
    readonly method: "attention.delivery.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "attention.delivery.test": {
    readonly method: "attention.delivery.test";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.mailPassword.update": {
    readonly method: "attention.mailPassword.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.mailPassword.delete": {
    readonly method: "attention.mailPassword.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.webAddress.update": {
    readonly method: "attention.webAddress.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.webAddress.secret.rotate": {
    readonly method: "attention.webAddress.secret.rotate";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "attention.webAddress.delete": {
    readonly method: "attention.webAddress.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link ATTENTION_METHOD_DESCRIPTORS}. */
export interface AttentionMethodTypes {
  readonly "attention.subscribe": {
    readonly params: AttentionSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: AttentionProjection;
  };
  readonly "attention.banner.settle": {
    readonly params: AttentionBannerSettleRequest;
    readonly result: EmptyPayload;
  };
  readonly "attention.seen.update": {
    readonly params: AttentionSeenUpdateRequest;
    readonly result: EmptyPayload;
  };
  readonly "attention.delivery.list": {
    readonly params: EmptyPayload;
    readonly result: AttentionDeliveryListResponse;
  };
  readonly "attention.delivery.test": {
    readonly params: AttentionDeliveryTestRequest;
    readonly result: AttentionDeliveryTestResponse;
  };
  readonly "attention.mailPassword.update": {
    readonly params: AttentionMailPasswordUpdateRequest;
    readonly result: EmptyPayload;
  };
  readonly "attention.mailPassword.delete": {
    readonly params: EmptyPayload;
    readonly result: EmptyPayload;
  };
  readonly "attention.webAddress.update": {
    readonly params: AttentionWebAddressUpdateRequest;
    readonly result: AttentionWebAddressUpdateResponse;
  };
  readonly "attention.webAddress.secret.rotate": {
    readonly params: EmptyPayload;
    readonly result: AttentionWebAddressSecretRotateResponse;
  };
  readonly "attention.webAddress.delete": {
    readonly params: EmptyPayload;
    readonly result: EmptyPayload;
  };
}
/** The `attention.*` methods. */
export const ATTENTION_METHOD_DESCRIPTORS: AttentionMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "attention.subscribe": /* @__PURE__ */ Object.freeze({
      method: "attention.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "attention.banner.settle": /* @__PURE__ */ Object.freeze({
      method: "attention.banner.settle",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.seen.update": /* @__PURE__ */ Object.freeze({
      method: "attention.seen.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.delivery.list": /* @__PURE__ */ Object.freeze({
      method: "attention.delivery.list",
      procedureType: "query",
      mutating: false,
    }),
    "attention.delivery.test": /* @__PURE__ */ Object.freeze({
      method: "attention.delivery.test",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.mailPassword.update": /* @__PURE__ */ Object.freeze({
      method: "attention.mailPassword.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.mailPassword.delete": /* @__PURE__ */ Object.freeze({
      method: "attention.mailPassword.delete",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.webAddress.update": /* @__PURE__ */ Object.freeze({
      method: "attention.webAddress.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.webAddress.secret.rotate": /* @__PURE__ */ Object.freeze({
      method: "attention.webAddress.secret.rotate",
      procedureType: "mutation",
      mutating: true,
    }),
    "attention.webAddress.delete": /* @__PURE__ */ Object.freeze({
      method: "attention.webAddress.delete",
      procedureType: "mutation",
      mutating: true,
    }),
  });
