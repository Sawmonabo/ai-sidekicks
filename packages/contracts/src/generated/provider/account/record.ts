// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The provider account record and how it is read: the account as sent on the wire, each provider's readiness and its remedy, the per-limit quota reading, `provider.account.list` and the `provider.account.subscribe` live tail.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { Place } from "../../place.js";
import type { ProviderId } from "../id.js";

/** The longest daemon-minted account id. */
export const PROVIDER_ACCOUNT_ID_MAX_LEN = 256 as const;

/** The longest name the person gives an account. */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN = 256 as const;

/** The longest provider-reported email; RFC 5321 caps a forward path at 320 octets. */
export const PROVIDER_ACCOUNT_EMAIL_MAX_LEN = 320 as const;

/** The longest provider-reported organization id. */
export const PROVIDER_ACCOUNT_ORG_ID_MAX_LEN = 256 as const;

/** The longest provider-reported organization name. */
export const PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN = 256 as const;

/** The longest daemon-minted id of one sign-in attempt. */
export const PROVIDER_SIGN_IN_ATTEMPT_ID_MAX_LEN = 256 as const;

/** The longest sign-in failure text shown to the person. */
export const PROVIDER_SIGN_IN_FAILURE_REASON_MAX_LEN = 512 as const;

/** The longest provider limit id. */
export const PROVIDER_QUOTA_LIMIT_ID_MAX_LEN = 128 as const;

/** The longest provider label for a quota window. */
export const PROVIDER_QUOTA_LABEL_MAX_LEN = 256 as const;

/** The longest provider plan id. */
export const PROVIDER_ACCOUNT_PLAN_MAX_LEN = 128 as const;

/**
 * The longest label an account is named by: the reported email, plan and organization with
 * the two three-character ` · ` separators between them, longer than a typed name beside its
 * credential's kind.
 */
export const PROVIDER_ACCOUNT_LABEL_MAX_LEN = 710 as const;

/** Every account health state, in declaration order. */
export const PROVIDER_ACCOUNT_HEALTH_STATES = [
  "authenticated",
  "reauthRequired",
  "homeMissing",
  "indeterminate",
] as const;

/** Every auth mode, in declaration order. */
export const PROVIDER_AUTH_MODES = [
  "oauthSubscription",
  "oauthToken",
  "apiKey",
  "external",
  "none",
  "unknown",
] as const;

/** Every source a quota reading comes from, in declaration order. */
export const PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES = ["probe", "run"] as const;

/** The generation a newly registered account starts at. */
export const CREDENTIAL_GENERATION_MIN = 1 as const;

/** The limit id a quota reading takes when it names none. */
export const PROVIDER_QUOTA_DEFAULT_LIMIT_ID = "default" as const;

/** Every way a brokered sign-in ends, in declaration order. */
export const PROVIDER_SIGN_IN_OUTCOMES = ["succeeded", "failed", "expired", "canceled"] as const;

/** Every readiness state, in declaration order. */
export const PROVIDER_READINESS_STATES = [
  "authenticated",
  "reauthRequired",
  "homeMissing",
  "indeterminate",
  "noAccount",
  "noCurrent",
] as const;

/**
 * How an account is charged. `unknown` means not known, never `metered`: it labels cost and
 * never derives it.
 */
export type BillingMode = "subscription" | "metered" | "unknown";
/**
 * The stored outcome of an account's last validation. `indeterminate` means the probe could not
 * decide or none has run; it counts as not authenticated, and a stored null is sent as it.
 */
export type ProviderAccountHealthState =
  | "authenticated"
  | "reauthRequired"
  | "homeMissing"
  | "indeterminate";
/**
 * The authentication mode the provider's own status output reports for a home; never assumed or
 * read from a credential file's shape. `unknown` is a mode this build does not recognize.
 */
export type ProviderAuthMode =
  | "oauthSubscription"
  | "oauthToken"
  | "apiKey"
  | "external"
  | "none"
  | "unknown";
/**
 * Which kind of reading produced a quota window: `probe` is the account's own limits read and
 * replaces the stored set; `run` is the provider's push during a turn and is merged in.
 */
export type ProviderAccountUsageWindowSource = "probe" | "run";
/**
 * The daemon-minted opaque id of one account, not a UUID and never derived from a
 * credential, an email or a path, since those rotate and the id keys historical spend.
 */
export type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
/**
 * A counter that starts at 1 and rises at each credential-home transition; it never decreases or resets.
 */
export type CredentialGeneration = number;
/**
 * How the account's one memory import went: `imported` counts what was copied and when,
 * `nothingToImport` found nothing. The outcome is kept on the account, and a repeat is refused.
 */
export type ProviderAccountMemoryImportOutcome =
  | {
      outcome: "imported";
      /**
       * How much.
       */
      count: number;
      /**
       * When.
       */
      importedAt: WireInstant;
    }
  | {
      outcome: "nothingToImport";
    };
/**
 * One registered provider account as sent on the wire. Only an `indeterminate` account may lack
 * the time its health state was observed.
 */
export type ProviderAccount =
  | {
      /**
       * The account's id.
       */
      accountId: ProviderAccountId;
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The name the person gave an account added from a pasted token or API key; absent
       * on every other account, which its provider-reported identity names.
       */
      displayLabel?: string;
      /**
       * The credential home's generation.
       */
      credentialGeneration: CredentialGeneration;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * The email the provider reported.
       */
      observedAccountEmail?: string;
      /**
       * The organization id the provider reported.
       */
      observedAccountOrgId?: string;
      /**
       * The organization name the provider reported.
       */
      observedAccountOrgName?: string;
      /**
       * The plan id exactly as the provider sends it.
       */
      observedAccountPlan?: string;
      /**
       * Whether this is the provider's default account; at most one is.
       */
      isDefault: boolean;
      /**
       * The places where the account has a home; absent on a computer without a WSL 2
       * distribution.
       *
       * @minItems 1
       */
      homePlaces?: [Place, ...Place[]];
      /**
       * The stored health state.
       */
      healthState: "authenticated" | "reauthRequired" | "homeMissing";
      /**
       * When the state was observed.
       */
      healthObservedAt: WireInstant;
      /**
       * The mode an observation named, or `null` until one has.
       */
      observedAuthMode: ProviderAuthMode | null;
      /**
       * When this home's credential was issued, or `null` where nothing produced the time.
       */
      signedInAt: WireInstant | null;
      /**
       * When the credential was last seen refreshed, or `null` for none seen.
       */
      lastRefreshObservedAt: WireInstant | null;
      /**
       * An estimate of when sign-in will be needed again, shown as approximate; `null`
       * when the issue time or the mode is.
       */
      signInNeededAtEstimate: WireInstant | null;
      /**
       * `false` when the person silenced the background observer for this account.
       */
      probeEnabled: boolean;
      /**
       * Start each usage window as soon as it opens; it does nothing while the observer is
       * off.
       */
      windowStartEnabled: boolean;
      /**
       * Wake this computer for a window that resets while it sleeps.
       */
      wakeForWindowStartEnabled: boolean;
      /**
       * The account's one memory import, or `null` until it has run.
       */
      memoryImport: ProviderAccountMemoryImportOutcome | null;
    }
  | {
      /**
       * The account's id.
       */
      accountId: ProviderAccountId;
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The name the person gave an account added from a pasted token or API key; absent
       * on every other account, which its provider-reported identity names.
       */
      displayLabel?: string;
      /**
       * The credential home's generation.
       */
      credentialGeneration: CredentialGeneration;
      /**
       * How the account is charged.
       */
      billingMode: BillingMode;
      /**
       * The email the provider reported.
       */
      observedAccountEmail?: string;
      /**
       * The organization id the provider reported.
       */
      observedAccountOrgId?: string;
      /**
       * The organization name the provider reported.
       */
      observedAccountOrgName?: string;
      /**
       * The plan id exactly as the provider sends it.
       */
      observedAccountPlan?: string;
      /**
       * Whether this is the provider's default account; at most one is.
       */
      isDefault: boolean;
      /**
       * The places where the account has a home; absent on a computer without a WSL 2
       * distribution.
       *
       * @minItems 1
       */
      homePlaces?: [Place, ...Place[]];
      /**
       * Always `indeterminate`.
       */
      healthState: "indeterminate";
      /**
       * When the state was observed, or `null` for never.
       */
      healthObservedAt: WireInstant | null;
      /**
       * The mode an observation named, or `null` until one has.
       */
      observedAuthMode: ProviderAuthMode | null;
      /**
       * When this home's credential was issued, or `null` where nothing produced the time.
       */
      signedInAt: WireInstant | null;
      /**
       * When the credential was last seen refreshed, or `null` for none seen.
       */
      lastRefreshObservedAt: WireInstant | null;
      /**
       * An estimate of when sign-in will be needed again, shown as approximate; `null`
       * when the issue time or the mode is.
       */
      signInNeededAtEstimate: WireInstant | null;
      /**
       * `false` when the person silenced the background observer for this account.
       */
      probeEnabled: boolean;
      /**
       * Start each usage window as soon as it opens; it does nothing while the observer is
       * off.
       */
      windowStartEnabled: boolean;
      /**
       * Wake this computer for a window that resets while it sleeps.
       */
      wakeForWindowStartEnabled: boolean;
      /**
       * The account's one memory import, or `null` until it has run.
       */
      memoryImport: ProviderAccountMemoryImportOutcome | null;
    };
/**
 * The pre-computed answer to what run admission will ask. The first four are the resolved
 * account's stored health state; `noAccount` and `noCurrent` stand where resolution reached no
 * account. It authorizes nothing: admission checks again.
 */
export type ProviderReadinessState =
  | "authenticated"
  | "reauthRequired"
  | "homeMissing"
  | "indeterminate"
  | "noAccount"
  | "noCurrent";
/**
 * The next step shown for a readiness state that is not `authenticated`. A client renders
 * off `kind`, not `state`, since `reauthRequired` takes `signIn` or `pasteToken`.
 */
export type ProviderRemedy =
  | {
      kind: "signIn";
      /**
       * The resolved account.
       */
      accountId: ProviderAccountId;
    }
  | {
      kind: "pasteToken";
      /**
       * The resolved account.
       */
      accountId: ProviderAccountId;
    }
  | {
      kind: "register";
      /**
       * The provider.
       */
      provider: ProviderId;
    }
  | {
      kind: "chooseCurrent";
      /**
       * The candidates; the daemon lists them and never picks one. One account that is not
       * current is still listed rather than elected.
       *
       * @minItems 1
       */
      candidateAccountIds: [ProviderAccountId, ...ProviderAccountId[]];
    }
  | {
      kind: "lookAgain";
      /**
       * The resolved account.
       */
      accountId: ProviderAccountId;
    };
/**
 * The remedy of one account whose sign-in is gone: the provider's own sign-in, or, on a
 * token or API-key account, a freshly minted token pasted in.
 */
export type ProviderSignInExpiredRemedy =
  | {
      kind: "signIn";
      /**
       * The resolved account.
       */
      accountId: ProviderAccountId;
    }
  | {
      kind: "pasteToken";
      /**
       * The resolved account.
       */
      accountId: ProviderAccountId;
    };
/**
 * One provider's readiness to start a run, tagged on `state`, with the remedy the state calls
 * for. A remedy that names an account names the entry's own resolved account, so the person is
 * never pointed at one account to fix another.
 */
export type ProviderReadiness =
  | {
      state: "authenticated";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached, when it reached exactly one.
       */
      resolvedAccountId?: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made.
       */
      observedAt?: WireInstant;
    }
  | ({
      remedy?: {
        accountId?: unknown;
      };
    } & {
      state: "reauthRequired";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached.
       */
      resolvedAccountId: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made.
       */
      observedAt?: WireInstant;
      /**
       * Sign in again, or paste a fresh token; which applies is the producer's call.
       */
      remedy: ProviderSignInExpiredRemedy;
    })
  | ({
      remedy?: {
        accountId?: unknown;
      };
    } & {
      state: "homeMissing";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached.
       */
      resolvedAccountId: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made.
       */
      observedAt?: WireInstant;
      /**
       * Sign in again.
       */
      remedy: ProviderSignInRemedy;
    })
  | ({
      remedy?: {
        accountId?: unknown;
      };
    } & {
      state: "indeterminate";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached.
       */
      resolvedAccountId: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made; absent for none yet.
       */
      observedAt?: WireInstant;
      /**
       * Look again.
       */
      remedy: ProviderLookAgainRemedy;
    })
  | {
      state: "noAccount";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached, when it reached exactly one.
       */
      resolvedAccountId?: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made.
       */
      observedAt?: WireInstant;
      /**
       * Register an account.
       */
      remedy: ProviderRegisterRemedy;
    }
  | {
      state: "noCurrent";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The account resolution reached, when it reached exactly one.
       */
      resolvedAccountId?: ProviderAccountId;
      /**
       * When the stored observation the state was read from was made.
       */
      observedAt?: WireInstant;
      /**
       * Choose the current account.
       */
      remedy: ProviderChooseCurrentRemedy;
    };
/**
 * How a brokered sign-in attempt ended.
 */
export type ProviderSignInOutcome = "succeeded" | "failed" | "expired" | "canceled";
/**
 * A change to the machine's account registry, which `provider.account.subscribe` sends as a full
 * state update, so seeing one twice is harmless. A usage window's reading belongs to the account
 * the notification routes to.
 */
export type ProviderAccountNotification =
  | {
      kind: "accountChanged";
      /**
       * The account as it now is.
       */
      account: ProviderAccount;
    }
  | {
      kind: "accountRemoved";
      /**
       * The account.
       */
      accountId: ProviderAccountId;
    }
  | {
      kind: "signInCodeRequested";
      /**
       * The attempt.
       */
      attemptId: string;
    }
  | {
      kind: "signInCompleted";
      /**
       * The attempt.
       */
      attemptId: string;
      /**
       * The account.
       */
      accountId: ProviderAccountId;
      /**
       * How it ended.
       */
      outcome: ProviderSignInOutcome;
      /**
       * Text for the person, with no credential, provider error body or home path.
       */
      failureReason?: string;
    }
  | ({
      window?: {
        accountId?: unknown;
      };
    } & {
      kind: "usageWindowUpdated";
      /**
       * The account the reading is routed to.
       */
      accountId: ProviderAccountId;
      /**
       * The reading; its own `accountId` is the routed one.
       */
      window: ProviderAccountUsageWindow;
    });

/**
 * Remedy for `noAccount`: register an account for the provider.
 */
export interface ProviderRegisterRemedy {
  /**
   * What the person does.
   */
  kind: "register";
  /**
   * The provider.
   */
  provider: ProviderId;
}
/**
 * Remedy for `noCurrent`: the person picks one of the listed accounts as the provider's
 * current account.
 */
export interface ProviderChooseCurrentRemedy {
  /**
   * What the person does.
   */
  kind: "chooseCurrent";
  /**
   * The candidates; the daemon lists them and never picks one. One account that is not
   * current is still listed rather than elected.
   *
   * @minItems 1
   */
  candidateAccountIds: [ProviderAccountId, ...ProviderAccountId[]];
}
/**
 * Remedy for a resolved account that is not authenticated: run the provider's own
 * sign-in.
 */
export interface ProviderSignInRemedy {
  /**
   * What the person does.
   */
  kind: "signIn";
  /**
   * The resolved account.
   */
  accountId: ProviderAccountId;
}
/**
 * Remedy for `reauthRequired` on a token or API-key account: it cannot refresh itself,
 * so the person mints a fresh token at the provider and pastes it.
 */
export interface ProviderPasteTokenRemedy {
  /**
   * What the person does.
   */
  kind: "pasteToken";
  /**
   * The resolved account.
   */
  accountId: ProviderAccountId;
}
/**
 * Remedy for `indeterminate`: nothing wrong can be seen, so the next read may settle it
 * and `provider.account.probe` asks again. Never a sign-in.
 */
export interface ProviderLookAgainRemedy {
  /**
   * What the person does.
   */
  kind: "lookAgain";
  /**
   * The resolved account.
   */
  accountId: ProviderAccountId;
}
/**
 * One quota reading for one window of one limit of one account, keyed by all three: a provider
 * can publish several limits that share a window length, and one limit with two windows at once.
 */
export interface ProviderAccountUsageWindow {
  /**
   * The account, since the list reply is one flat array over all accounts.
   */
  accountId: ProviderAccountId;
  /**
   * The provider's own limit id, as sent; a reading that names none takes
   * [`PROVIDER_QUOTA_DEFAULT_LIMIT_ID`].
   */
  limitId: string;
  /**
   * The window's length in minutes.
   */
  windowMins: number;
  /**
   * The provider's own label for the window, never parsed.
   */
  label?: string;
  /**
   * Utilization when observed, not clamped to 100, since a provider may report
   * over-consumption.
   */
  usedPercent: number;
  /**
   * When the window resets, where the provider says.
   */
  resetsAt?: WireInstant;
  /**
   * When it was read: the newest per account and limit wins, and `source` breaks ties.
   */
  observedAt: WireInstant;
  /**
   * The account's credential generation when this was read, so an earlier one reads stale.
   */
  observedCredentialGeneration: CredentialGeneration;
  /**
   * Which kind of reading produced it.
   */
  source: ProviderAccountUsageWindowSource;
}
/**
 * The request of `provider.account.list`.
 */
export interface ProviderAccountListRequest {
  /**
   * The provider to read, or every one.
   */
  provider?: ProviderId;
  /**
   * Scopes readiness to one account instead of the provider's default; an unknown or removed
   * id is refused, never replaced by the default.
   */
  accountId?: ProviderAccountId;
}
/**
 * The reply of `provider.account.list`: the accounts, the stored quota readings (sent on the read
 * because the subscription is a live tail), and exactly one readiness entry per provider read.
 */
export interface ProviderAccountListResponse {
  /**
   * The accounts.
   */
  accounts: ProviderAccount[];
  /**
   * The stored quota readings.
   */
  usageWindows: ProviderAccountUsageWindow[];
  /**
   * One readiness entry per provider read.
   */
  readiness: ProviderReadiness[];
}

export {
  validateBillingMode,
  validateCredentialGeneration,
  validateProviderAccount,
  validateProviderAccountHealthState,
  validateProviderAccountId,
  validateProviderAccountListRequest,
  validateProviderAccountListResponse,
  validateProviderAccountMemoryImportOutcome,
  validateProviderAccountNotification,
  validateProviderAccountUsageWindow,
  validateProviderAccountUsageWindowSource,
  validateProviderAuthMode,
  validateProviderChooseCurrentRemedy,
  validateProviderLookAgainRemedy,
  validateProviderReadiness,
  validateProviderReadinessState,
  validateProviderRegisterRemedy,
  validateProviderRemedy,
  validateProviderSignInExpiredRemedy,
  validateProviderSignInOutcome,
  validateProviderSignInRemedy,
} from "../../checks/provider/account/record.js";
