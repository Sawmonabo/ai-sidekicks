// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `provider.account.*` methods not in the sign-in module (update, delete, current update, probe, memory import, usage list) and the namespace's method table.

import type { SchemaCheck } from "../../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../../checks/jsonrpc/streaming.js";
import { validateEmptyPayload } from "../../checks/method-descriptor.js";
import {
  validateProviderAccountCurrentUpdateRequest,
  validateProviderAccountCurrentUpdateResponse,
  validateProviderAccountDeleteRequest,
  validateProviderAccountDeleteResponse,
  validateProviderAccountMemoryImportRequest,
  validateProviderAccountProbeRequest,
  validateProviderAccountProbeResponse,
  validateProviderAccountUpdateRequest,
  validateProviderAccountUpdateResponse,
  validateProviderAccountUsageListRequest,
  validateProviderAccountUsageListResponse,
} from "../../checks/provider/account/methods.js";
import {
  validateProviderAccountListRequest,
  validateProviderAccountListResponse,
  validateProviderAccountMemoryImportOutcome,
  validateProviderAccountNotification,
} from "../../checks/provider/account/record.js";
import {
  validateProviderAccountCredentialHomeResetRequest,
  validateProviderAccountCredentialHomeResetResponse,
  validateProviderAccountRegisterRequest,
  validateProviderAccountRegisterResponse,
  validateProviderAccountSignInAttemptCancelRequest,
  validateProviderAccountSignInAttemptCancelResponse,
  validateProviderAccountSignInCodeSubmitRequest,
  validateProviderAccountSignInCodeSubmitResponse,
  validateProviderAccountSignInRequest,
  validateProviderAccountSignInResponse,
} from "../../checks/provider/account/sign-in.js";
import type { WireDate, WireInstant } from "../../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../../jsonrpc/streaming.js";
import type { KeychainRefusalCause } from "../../keychain.js";
import type { EmptyPayload } from "../../method-descriptor.js";
import type { UsdMicros } from "../../session/cost.js";
import type { SessionId } from "../../session/id.js";
import type { WorkflowRunId } from "../../workflow/run/id.js";
import type { ProviderId } from "../id.js";
import type {
  BillingMode,
  CredentialGeneration,
  ProviderAccount,
  ProviderAccountHealthState,
  ProviderAccountId,
  ProviderAccountListRequest,
  ProviderAccountListResponse,
  ProviderAccountMemoryImportOutcome,
  ProviderAccountNotification,
  ProviderSignInExpiredRemedy,
} from "./record.js";
import type {
  ProviderAccountCredentialHomeResetRequest,
  ProviderAccountCredentialHomeResetResponse,
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterResponse,
  ProviderAccountSignInAttemptCancelRequest,
  ProviderAccountSignInAttemptCancelResponse,
  ProviderAccountSignInCodeSubmitRequest,
  ProviderAccountSignInCodeSubmitResponse,
  ProviderAccountSignInRequest,
  ProviderAccountSignInResponse,
} from "./sign-in.js";

/** The longest model id on a usage row, as the provider names it. */
export const PROVIDER_ACCOUNT_USAGE_MODEL_MAX_LEN = 128 as const;

/** The longest reason the wake helper did not install, in the installer's own words. */
export const PROVIDER_WAKE_HELPER_REASON_MAX_LEN = 1024 as const;

/**
 * The update renamed an account the person did not name: only an account added from a
 * pasted token or API key carries a typed name.
 */
export const PROVIDER_ACCOUNT_RENAME_REFUSED_CODE = "provider.account.renameRefused" as const;

/** No account is registered for the provider a run needs, so the run is not admitted. */
export const PROVIDER_ACCOUNT_NOT_REGISTERED_CODE = "provider.account.notRegistered" as const;

/**
 * The provider has accounts but none is current, so a run's account is ambiguous and it is
 * not admitted.
 */
export const PROVIDER_ACCOUNT_CURRENT_NOT_SET_CODE = "provider.account.current.notSet" as const;

/**
 * A run bound to the account is live, or a workflow step waits on it, so it is not removed;
 * the refusal names the sessions or the workflow runs.
 */
export const PROVIDER_ACCOUNT_IN_USE_CODE = "provider.account.inUse" as const;

/**
 * The place the daemon keeps its secrets would not destroy the account's token, so the
 * removal stopped; the account no longer reads as registered and the next start finishes it.
 */
export const PROVIDER_ACCOUNT_CREDENTIAL_DESTROY_REFUSED_CODE =
  "provider.account.credentialDestroyRefused" as const;

/**
 * The named account is not signed in, so it is refused as a switch target before anything
 * moves.
 */
export const PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE = "provider.account.notAuthenticated" as const;

/** The account's one memory import has already run, so it is not run again. */
export const PROVIDER_ACCOUNT_MEMORY_ALREADY_IMPORTED_CODE =
  "provider.account.memory.alreadyImported" as const;

/**
 * Where the helper that wakes this computer for a window start stands. The update reply reads
 * `installed` or `notInstalled`, one that did not install leaving the switch off and giving its
 * reason; `daemon.status.read` reads `installed`, `turnedOff` (turned off in the system's login
 * items) or `missing`.
 */
export type ProviderWakeHelperState =
  | {
      state: "installed";
    }
  | {
      state: "notInstalled";
      /**
       * Why, in the installer's own words.
       */
      reason: string;
    }
  | {
      state: "turnedOff";
    }
  | {
      state: "missing";
    };
/**
 * What holds the account a removal refused: the sessions whose live runs are on it, or the
 * workflow runs with a step parked waiting on it; at least one is named either way.
 */
export type ProviderAccountInUseDetails =
  | {
      heldBy: "sessions";
      /**
       * The sessions.
       *
       * @minItems 1
       */
      sessionIds: [SessionId, ...SessionId[]];
    }
  | {
      heldBy: "waitingSteps";
      /**
       * The workflow runs.
       *
       * @minItems 1
       */
      workflowRunIds: [WorkflowRunId, ...WorkflowRunId[]];
    };
/**
 * The account now current and the sessions the switch is moving.
 */
export type ProviderAccountCurrentUpdateResponse = {
  account?: {
    isDefault?: true;
  };
} & {
  /**
   * The account now current, so it carries the default mark.
   */
  account: ProviderAccount;
  /**
   * The sessions the switch is moving; empty when nothing ran on that provider or the account
   * was already current.
   */
  movingSessions: ProviderAccountMovingSession[];
};
/**
 * The accounts a usage read covers: one account, or every account of one provider.
 */
export type ProviderAccountUsageScope =
  | {
      /**
       * The account.
       */
      accountId: ProviderAccountId;
    }
  | {
      /**
       * The provider.
       */
      provider: ProviderId;
    };
/**
 * How a usage read splits its figures: by calendar day, or by model.
 */
export type ProviderAccountUsageGrouping = "day" | "model";

/**
 * Edits an account's descriptive settings; an omitted member is unchanged. The provider, the
 * credential home, the credential generation and the default mark are not changed here.
 */
export interface ProviderAccountUpdateRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * Renames an account added from a pasted token or API key; refused on any other.
   */
  displayLabel?: string;
  /**
   * How `unknown` is resolved to a declared mode.
   */
  billingMode?: BillingMode;
  /**
   * The lasting per-account opt-out for the background observer; on by default.
   */
  probeEnabled?: boolean;
  /**
   * Start each usage window as soon as it opens; it does nothing while the observer is off,
   * and turning it on then is kept rather than refused.
   */
  windowStartEnabled?: boolean;
  /**
   * Wake this computer for a window that resets while it sleeps; the first account turned on
   * installs the wake helper and the last one turned off removes it.
   */
  wakeForWindowStartEnabled?: boolean;
}
/**
 * The updated account.
 */
export interface ProviderAccountUpdateResponse {
  /**
   * The account.
   */
  account: ProviderAccount;
  /**
   * Present when the request changed the wake switch on a machine that uses the helper.
   */
  wakeHelper?: ProviderWakeHelperState;
}
/**
 * Removes one account.
 */
export interface ProviderAccountDeleteRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The removed account's id.
 */
export interface ProviderAccountDeleteResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * Always `true`: removal has no partial success, and every refusal is a typed error.
   */
  removed: true;
}
/**
 * The details of a refused destroy of the account's sealed token.
 */
export interface ProviderAccountCredentialDestroyRefusedDetails {
  /**
   * Why the keychain could not be used.
   */
  cause: KeychainRefusalCause;
}
/**
 * Makes this account its provider's current account, the one the default mark sits on. New
 * sessions on that provider start on it and every running session there not pinned to an
 * account moves to it; no credential is touched.
 */
export interface ProviderAccountCurrentUpdateRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * One running session the switch is moving, in place, at its next provider request.
 */
export interface ProviderAccountMovingSession {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The refused account's own remedy, so the refusal points at the one way back for it.
 */
export interface ProviderAccountNotAuthenticatedDetails {
  /**
   * The remedy.
   */
  remedy: ProviderSignInExpiredRemedy;
}
/**
 * Checks one account's health now.
 */
export interface ProviderAccountProbeRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * The account's health as the probe read it.
 */
export interface ProviderAccountProbeResponse {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
  /**
   * The health read.
   */
  healthState: ProviderAccountHealthState;
  /**
   * The generation the probe saw; a later rise makes this reading stale.
   */
  credentialGeneration: CredentialGeneration;
}
/**
 * Copies the person's own provider memory into this account's home, once, never overwriting a
 * file, and answers with the outcome the account keeps; a repeat is refused and copies nothing.
 */
export interface ProviderAccountMemoryImportRequest {
  /**
   * The account.
   */
  accountId: ProviderAccountId;
}
/**
 * Reads tokens and spend per account from the per-turn records; a subscription account's tokens
 * are priced at the provider's published per-token rates.
 */
export interface ProviderAccountUsageListRequest {
  /**
   * The accounts read.
   */
  scope: ProviderAccountUsageScope;
  /**
   * The inclusive start; absent reads from the first recorded turn.
   */
  from?: WireInstant;
  /**
   * The exclusive end; absent reads to now.
   */
  to?: WireInstant;
  /**
   * How the figures split; absent gives one row for the whole range.
   */
  groupBy?: ProviderAccountUsageGrouping;
}
/**
 * One figure: the tokens and what they cost, in whole micro-dollars. `day` is set on a row
 * grouped by day and `model` on a row grouped by model.
 */
export interface ProviderAccountUsageRow {
  /**
   * The calendar day.
   */
  day?: WireDate;
  /**
   * The model, as the provider names it.
   */
  model?: string;
  /**
   * The tokens.
   */
  tokens: number;
  /**
   * What they cost.
   */
  costUsdMicros: UsdMicros;
}
/**
 * The usage rows for the requested range and grouping.
 */
export interface ProviderAccountUsageListResponse {
  /**
   * The rows.
   */
  rows: ProviderAccountUsageRow[];
}

export {
  validateProviderAccountCredentialDestroyRefusedDetails,
  validateProviderAccountCurrentUpdateRequest,
  validateProviderAccountCurrentUpdateResponse,
  validateProviderAccountDeleteRequest,
  validateProviderAccountDeleteResponse,
  validateProviderAccountInUseDetails,
  validateProviderAccountMemoryImportRequest,
  validateProviderAccountMovingSession,
  validateProviderAccountNotAuthenticatedDetails,
  validateProviderAccountProbeRequest,
  validateProviderAccountProbeResponse,
  validateProviderAccountUpdateRequest,
  validateProviderAccountUpdateResponse,
  validateProviderAccountUsageGrouping,
  validateProviderAccountUsageListRequest,
  validateProviderAccountUsageListResponse,
  validateProviderAccountUsageRow,
  validateProviderAccountUsageScope,
  validateProviderWakeHelperState,
} from "../../checks/provider/account/methods.js";

/** The methods of {@link PROVIDER_ACCOUNT_METHOD_DESCRIPTORS}, each with its checks. */
export interface ProviderAccountMethodDescriptors {
  readonly "provider.account.list": {
    readonly method: "provider.account.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderAccountListRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountListResponse>;
  };
  readonly "provider.account.subscribe": {
    readonly method: "provider.account.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<ProviderAccountNotification>;
  };
  readonly "provider.account.register": {
    readonly method: "provider.account.register";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountRegisterRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountRegisterResponse>;
  };
  readonly "provider.account.update": {
    readonly method: "provider.account.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountUpdateResponse>;
  };
  readonly "provider.account.delete": {
    readonly method: "provider.account.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountDeleteRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountDeleteResponse>;
  };
  readonly "provider.account.current.update": {
    readonly method: "provider.account.current.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountCurrentUpdateRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountCurrentUpdateResponse>;
  };
  readonly "provider.account.probe": {
    readonly method: "provider.account.probe";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountProbeRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountProbeResponse>;
  };
  readonly "provider.account.credentialHome.reset": {
    readonly method: "provider.account.credentialHome.reset";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountCredentialHomeResetRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountCredentialHomeResetResponse>;
  };
  readonly "provider.account.signIn": {
    readonly method: "provider.account.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInResponse>;
  };
  readonly "provider.account.signInCode.submit": {
    readonly method: "provider.account.signInCode.submit";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInCodeSubmitRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInCodeSubmitResponse>;
  };
  readonly "provider.account.signInAttempt.cancel": {
    readonly method: "provider.account.signInAttempt.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountSignInAttemptCancelRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountSignInAttemptCancelResponse>;
  };
  readonly "provider.account.memory.import": {
    readonly method: "provider.account.memory.import";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<ProviderAccountMemoryImportRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountMemoryImportOutcome>;
  };
  readonly "provider.account.usage.list": {
    readonly method: "provider.account.usage.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<ProviderAccountUsageListRequest>;
    readonly responseCheck: SchemaCheck<ProviderAccountUsageListResponse>;
  };
}
/** Every `provider.account.*` method: its name, how it answers, and its shapes. */
export const PROVIDER_ACCOUNT_METHOD_DESCRIPTORS: ProviderAccountMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "provider.account.list": /* @__PURE__ */ Object.freeze({
      method: "provider.account.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderAccountListRequest,
      responseCheck: validateProviderAccountListResponse,
    }),
    "provider.account.subscribe": /* @__PURE__ */ Object.freeze({
      method: "provider.account.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateProviderAccountNotification,
    }),
    "provider.account.register": /* @__PURE__ */ Object.freeze({
      method: "provider.account.register",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountRegisterRequest,
      responseCheck: validateProviderAccountRegisterResponse,
    }),
    "provider.account.update": /* @__PURE__ */ Object.freeze({
      method: "provider.account.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountUpdateRequest,
      responseCheck: validateProviderAccountUpdateResponse,
    }),
    "provider.account.delete": /* @__PURE__ */ Object.freeze({
      method: "provider.account.delete",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountDeleteRequest,
      responseCheck: validateProviderAccountDeleteResponse,
    }),
    "provider.account.current.update": /* @__PURE__ */ Object.freeze({
      method: "provider.account.current.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountCurrentUpdateRequest,
      responseCheck: validateProviderAccountCurrentUpdateResponse,
    }),
    "provider.account.probe": /* @__PURE__ */ Object.freeze({
      method: "provider.account.probe",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountProbeRequest,
      responseCheck: validateProviderAccountProbeResponse,
    }),
    "provider.account.credentialHome.reset": /* @__PURE__ */ Object.freeze({
      method: "provider.account.credentialHome.reset",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountCredentialHomeResetRequest,
      responseCheck: validateProviderAccountCredentialHomeResetResponse,
    }),
    "provider.account.signIn": /* @__PURE__ */ Object.freeze({
      method: "provider.account.signIn",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountSignInRequest,
      responseCheck: validateProviderAccountSignInResponse,
    }),
    "provider.account.signInCode.submit": /* @__PURE__ */ Object.freeze({
      method: "provider.account.signInCode.submit",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountSignInCodeSubmitRequest,
      responseCheck: validateProviderAccountSignInCodeSubmitResponse,
    }),
    "provider.account.signInAttempt.cancel": /* @__PURE__ */ Object.freeze({
      method: "provider.account.signInAttempt.cancel",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountSignInAttemptCancelRequest,
      responseCheck: validateProviderAccountSignInAttemptCancelResponse,
    }),
    "provider.account.memory.import": /* @__PURE__ */ Object.freeze({
      method: "provider.account.memory.import",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateProviderAccountMemoryImportRequest,
      responseCheck: validateProviderAccountMemoryImportOutcome,
    }),
    "provider.account.usage.list": /* @__PURE__ */ Object.freeze({
      method: "provider.account.usage.list",
      procedureType: "query",
      mutating: false,
      requestCheck: validateProviderAccountUsageListRequest,
      responseCheck: validateProviderAccountUsageListResponse,
    }),
  });
