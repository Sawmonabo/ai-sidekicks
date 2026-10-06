// The `providerAccount.*` account record and how it is read: the account record as sent on the
// wire, each provider's readiness and its remedy, the per-limit quota-window reading,
// `providerAccount.list`, and the `providerAccount.subscribe` live tail. Registering and
// signing in are in `provider/account/sign-in.ts`; the other account methods and the method
// table are in `provider/account/methods.ts`.
//
// `ProviderAuthModeSchema` is closed: the daemon produces every value on the wire, so an
// unknown one is a defect and fails loudly. The tolerance sits where a provider's own status
// output is read: `normalizeObservedProviderAuthMode` maps an unrecognized mode to `unknown`
// and never throws.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import { isoDateTimeSchema } from "../../internal/wire-scalars.js";
import { ProviderNameSchema, type ProviderName } from "../name.js";

// Length caps. Wire-only bounds that stop one oversized member long before the transport's
// body-size limit; the database declares no length CHECK on these columns.

/** Longest daemon-minted opaque account id. */
export const PROVIDER_ACCOUNT_ID_MAX_LEN = 256;
/** Longest account label the person chooses. */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN = 256;
/** Longest provider-reported email; RFC 5321 caps a forward path at 320 octets. */
export const PROVIDER_ACCOUNT_EMAIL_MAX_LEN = 320;
/** Longest provider-reported organization id. */
export const PROVIDER_ACCOUNT_ORG_ID_MAX_LEN = 256;
/** Longest provider-reported organization name. */
export const PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN = 256;
/** Longest daemon-minted id of one sign-in attempt. */
export const PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN = 256;
/** Longest sign-in failure text shown to the person. */
export const PROVIDER_LOGIN_FAILURE_REASON_MAX_LEN = 512;
/** Longest provider limit id. */
export const PROVIDER_QUOTA_LIMIT_ID_MAX_LEN = 128;
/** Longest provider label for a quota window. */
export const PROVIDER_QUOTA_LABEL_MAX_LEN = 256;
/** Longest provider plan id. */
export const PROVIDER_ACCOUNT_PLAN_MAX_LEN = 128;
/**
 * Longest label an account is named by: the provider-reported email, plan and organization with
 * the two ` · ` separators between them, which outruns a typed name beside its credential's kind.
 */
export const PROVIDER_ACCOUNT_LABEL_MAX_LEN: number =
  PROVIDER_ACCOUNT_EMAIL_MAX_LEN +
  PROVIDER_ACCOUNT_PLAN_MAX_LEN +
  PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN +
  2 * " · ".length;

/**
 * The form two typed account names are compared in, so the service's uniqueness check and the
 * screen's agree on every name: compatibility-normalized (NFKC), case-folded with the
 * locale-independent case mappings, and trimmed of Unicode whitespace. `Ärzte` and ` ärzte `
 * compare equal.
 */
export function comparableDisplayLabel(displayLabel: string): string {
  // Upper then lower folds the cases a single lowering misses (`ß` and `SS` both become `ss`);
  // the second NFKC recomposes what case mapping decomposed. `toLocale*` is not used, because
  // its answer moves with the machine's locale.
  return displayLabel.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC").trim();
}

// Each enum is one literal tuple surfaced twice: as the Zod schema the wire parses with, and as
// a `readonly` array the schema conformance test compares with the database CHECK list.

const BILLING_MODE_VALUES = ["subscription", "metered", "unknown"] as const;

/**
 * How an account is charged. `unknown` means not known, never `metered`: it labels cost and
 * never derives it, so showing it as metered would claim spend the daemon cannot support.
 */
export type BillingMode = (typeof BILLING_MODE_VALUES)[number];
/** Parses a {@link BillingMode}. */
export const BillingModeSchema: z.ZodType<BillingMode, BillingMode> = z.enum(BILLING_MODE_VALUES);

const PROVIDER_ACCOUNT_HEALTH_STATE_VALUES = [
  "authenticated",
  "reauth_required",
  "home_missing",
  "indeterminate",
] as const;

/**
 * The stored outcome of an account's last validation: the authentication probe reading with
 * the credential-home observation taken at the same moment. `indeterminate` means the probe
 * could not decide or none has run; it counts as not authenticated. The column is nullable
 * and this wire value is not, so a NULL stored reading is sent as `indeterminate`.
 */
export type ProviderAccountHealthState = (typeof PROVIDER_ACCOUNT_HEALTH_STATE_VALUES)[number];
/**
 * Every `ProviderAccountHealthState`, in declaration order.
 *
 * @consumedBy an account's row on Settings › Providers, which draws its state in words
 */
export const PROVIDER_ACCOUNT_HEALTH_STATES: readonly ProviderAccountHealthState[] =
  PROVIDER_ACCOUNT_HEALTH_STATE_VALUES;
/** Parses a {@link ProviderAccountHealthState}. */
export const ProviderAccountHealthStateSchema: z.ZodType<
  ProviderAccountHealthState,
  ProviderAccountHealthState
> = z.enum(PROVIDER_ACCOUNT_HEALTH_STATE_VALUES);

const PROVIDER_AUTH_MODE_VALUES = [
  "oauth_subscription",
  "oauth_token",
  "api_key",
  "external",
  "none",
  "unknown",
] as const;

/**
 * The authentication mode the provider's own status output reports for a home; never assumed
 * or read from a credential file's shape. `unknown` means the provider named a mode this
 * build does not recognize (see `normalizeObservedProviderAuthMode`). The token value is
 * never on the wire.
 */
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODE_VALUES)[number];
/** Every `ProviderAuthMode`, in declaration order. */
export const PROVIDER_AUTH_MODES: readonly ProviderAuthMode[] = PROVIDER_AUTH_MODE_VALUES;
/** Parses a {@link ProviderAuthMode}; closed, so an unlisted value fails. */
export const ProviderAuthModeSchema: z.ZodType<ProviderAuthMode, ProviderAuthMode> =
  z.enum(PROVIDER_AUTH_MODE_VALUES);

const PROVIDER_READINESS_STATE_VALUES = [
  "authenticated",
  "reauth_required",
  "home_missing",
  "indeterminate",
  "no_account",
  "no_default",
] as const;

/**
 * The pre-computed answer to what run admission will ask. The first four values are the
 * resolved account's stored health state; `no_account` and `no_default` stand in where
 * resolution reached no account. It is listed in full, not aliased to the health state, so a
 * new health value cannot widen it silently. It authorizes nothing: admission re-validates.
 */
export type ProviderReadinessState = (typeof PROVIDER_READINESS_STATE_VALUES)[number];
/**
 * Every `ProviderReadinessState`, in declaration order.
 *
 * @consumedBy the Providers page's state and the one remedy that applies to it
 */
export const PROVIDER_READINESS_STATES: readonly ProviderReadinessState[] =
  PROVIDER_READINESS_STATE_VALUES;
/** Parses a {@link ProviderReadinessState}. */
export const ProviderReadinessStateSchema: z.ZodType<
  ProviderReadinessState,
  ProviderReadinessState
> = z.enum(PROVIDER_READINESS_STATE_VALUES);

const PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES = ["probe", "run"] as const;

/**
 * Which kind of reading produced a quota window. `probe` is the account's own limits read,
 * whoever asked for it; it covers the whole account and replaces the stored set. `run` is the
 * provider's push during a turn; it names only the windows it carries and is merged in.
 */
export type ProviderAccountUsageWindowSource =
  (typeof PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES)[number];
/**
 * Every `ProviderAccountUsageWindowSource`, in declaration order.
 *
 * @consumedBy the provider limits reads: the five-minute limits read and the turn-end read
 */
export const PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES: readonly ProviderAccountUsageWindowSource[] =
  PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES;
/** Parses a {@link ProviderAccountUsageWindowSource}. */
export const ProviderAccountUsageWindowSourceSchema: z.ZodType<
  ProviderAccountUsageWindowSource,
  ProviderAccountUsageWindowSource
> = z.enum(PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES);

/**
 * Maps a provider's reported authentication mode onto `ProviderAuthMode`; never throws, so a
 * new vendor mode costs precision, not the observation. Returns `null` when nothing (or only
 * blank text) was reported, which is not the same as `"unknown"` (reported but unrecognized).
 * The input is `unknown` because it comes from a provider's untyped status output.
 */
export function normalizeObservedProviderAuthMode(reportedMode: unknown): ProviderAuthMode | null {
  if (typeof reportedMode !== "string") {
    return reportedMode === null || reportedMode === undefined ? null : "unknown";
  }
  const trimmedMode = reportedMode.trim();
  if (trimmedMode.length === 0) {
    return null;
  }
  return (PROVIDER_AUTH_MODE_VALUES as readonly string[]).includes(trimmedMode)
    ? (trimmedMode as ProviderAuthMode)
    : "unknown";
}

/**
 * Daemon-minted opaque account id; not a UUID. It is not derived from credentials, an email,
 * a subscription id or a path, because those rotate and the id keys historical spend. Nothing
 * parses it; it only selects a credential environment.
 */
export type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
/** Parses a {@link ProviderAccountId}; not a UUID, so it brands the string itself. */
export const ProviderAccountIdSchema: z.ZodType<ProviderAccountId, ProviderAccountId> = z
  .string()
  .min(1)
  .max(PROVIDER_ACCOUNT_ID_MAX_LEN)
  .brand<"ProviderAccountId">() as unknown as z.ZodType<ProviderAccountId, ProviderAccountId>;

/** The generation a newly registered account starts at. */
export const CREDENTIAL_GENERATION_MIN = 1;

/**
 * Per-account counter that starts at `CREDENTIAL_GENERATION_MIN` and rises at each
 * credential-home transition; it never decreases or resets, even across a home reset.
 */
export type CredentialGeneration = number;
/**
 * Parses a {@link CredentialGeneration}: an integer at or above the minimum. A fraction would
 * match no stored value, and 0 would order before the account it describes.
 */
export const CredentialGenerationSchema: z.ZodType<CredentialGeneration, CredentialGeneration> = z
  .number()
  .int()
  .min(CREDENTIAL_GENERATION_MIN);

// `ProviderAccount` is a projection of the table row, not a mirror. Left out on purpose:
// `credential_home_path` (no screen shows it),
// `created_at` / `updated_at` (`updated_at` moves on a relabel, so beside the health pair it
// would look like a fresh observation), and `removal_intent` (a marked row is refused at
// admission and never shown). The three memory-import columns become `memoryImport`, and
// `expectedReloginAtEstimate` has no column: it is derived from `loggedInAt` on read.

/**
 * How the account's one memory import went: `imported` counts what was copied and when,
 * `nothingToImport` found nothing to copy. The outcome is kept, so a repeat answers it again
 * rather than copying twice.
 */
export type ProviderAccountMemoryImportOutcome =
  | { outcome: "imported"; count: number; importedAt: string }
  | { outcome: "nothingToImport" };

/** Parses a {@link ProviderAccountMemoryImportOutcome}. */
export const ProviderAccountMemoryImportOutcomeSchema: z.ZodType<
  ProviderAccountMemoryImportOutcome,
  ProviderAccountMemoryImportOutcome
> = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("imported"),
      count: z.number().int().positive(),
      importedAt: isoDateTimeSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("nothingToImport") }).strict(),
]);

/** One registered provider account as sent on the wire. */
export interface ProviderAccount {
  accountId: ProviderAccountId;
  provider: ProviderName;
  /**
   * The name the person gave an account added from a pasted token or API key, which its provider
   * names nowhere; personal data. Absent on every other account, which its provider-reported
   * identity names.
   */
  displayLabel?: string | undefined;
  credentialGeneration: CredentialGeneration;
  billingMode: BillingMode;
  /**
   * Provider-reported identity, present only where a health observation surfaced it. Each
   * member is optional on its own because a provider may report any subset.
   */
  observedAccountEmail?: string | undefined;
  observedAccountOrgId?: string | undefined;
  observedAccountOrgName?: string | undefined;
  /** The plan id exactly as the provider sends it (`promax`, `pro`). */
  observedAccountPlan?: string | undefined;
  /** At most one account per provider is the default; a partial unique index enforces it. */
  isDefault: boolean;
  healthState: ProviderAccountHealthState;
  /**
   * When `healthState` was observed; the database sets and clears the two together. `null`
   * means never observed, which `healthState` alone cannot say, since a never-probed account
   * and an undecided probe are both `indeterminate`. It rides the account record because
   * readiness covers only the resolved account, so every other account would otherwise have
   * a state with no age. Never taken from `updated_at`.
   */
  healthObservedAt: string | null;
  /** `null` until a health observation has named a mode. */
  observedAuthMode: ProviderAuthMode | null;
  /**
   * RFC 3339 UTC when this home's credential was issued, not when it was registered. `null`
   * where neither a sign-in nor a token registration produced an issuance time.
   */
  loggedInAt: string | null;
  /**
   * When the credential was last seen refreshed. `null` means none observed, not that none
   * was needed; an account signed in with a pasted token never has one.
   */
  lastRefreshObservedAt: string | null;
  /**
   * An estimate of when sign-in will be needed again, derived from `loggedInAt` and the
   * auth mode; `null` when either is null. A renderer must show it as approximate.
   */
  expectedReloginAtEstimate: string | null;
  /**
   * `false` means the person silenced the background observer for this account. The probe
   * verb and spawn validation still write the stored health pair.
   */
  probeEnabled: boolean;
  /**
   * Start each usage window as soon as it opens, with one small turn on the
   * smallest model. On by default; it does nothing while `probeEnabled` is off.
   */
  windowStartEnabled: boolean;
  /**
   * Wake this computer for a window that resets while it sleeps. Off by default,
   * and it does nothing while `windowStartEnabled` is off.
   */
  wakeForWindowStartEnabled: boolean;
  /** The account's one memory import, or `null` until it has run. */
  memoryImport: ProviderAccountMemoryImportOutcome | null;
}

/** Parses a {@link ProviderAccount}; rejects a non-`indeterminate` state without a timestamp. */
export const ProviderAccountSchema: z.ZodType<ProviderAccount, ProviderAccount> = z
  .object({
    accountId: ProviderAccountIdSchema,
    provider: ProviderNameSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccount.displayLabel",
    ).optional(),
    credentialGeneration: CredentialGenerationSchema,
    billingMode: BillingModeSchema,
    observedAccountEmail: wireFreeFormString(
      PROVIDER_ACCOUNT_EMAIL_MAX_LEN,
      "ProviderAccount.observedAccountEmail",
    ).optional(),
    observedAccountOrgId: wireFreeFormString(
      PROVIDER_ACCOUNT_ORG_ID_MAX_LEN,
      "ProviderAccount.observedAccountOrgId",
    ).optional(),
    observedAccountOrgName: wireFreeFormString(
      PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN,
      "ProviderAccount.observedAccountOrgName",
    ).optional(),
    observedAccountPlan: wireFreeFormString(
      PROVIDER_ACCOUNT_PLAN_MAX_LEN,
      "ProviderAccount.observedAccountPlan",
    ).optional(),
    isDefault: z.boolean(),
    healthState: ProviderAccountHealthStateSchema,
    healthObservedAt: isoDateTimeSchema.nullable(),
    // Nullable, not optional: an optional member would make "unobserved" and "the producer
    // forgot" the same value on the wire.
    observedAuthMode: ProviderAuthModeSchema.nullable(),
    loggedInAt: isoDateTimeSchema.nullable(),
    lastRefreshObservedAt: isoDateTimeSchema.nullable(),
    expectedReloginAtEstimate: isoDateTimeSchema.nullable(),
    probeEnabled: z.boolean(),
    windowStartEnabled: z.boolean(),
    wakeForWindowStartEnabled: z.boolean(),
    memoryImport: ProviderAccountMemoryImportOutcomeSchema.nullable(),
  })
  .strict()
  .superRefine((account, context) => {
    // Only `indeterminate` can lack a timestamp ("never probed"); it can also carry one
    // ("probed, could not decide"). The other states are outcomes of an observation, and one
    // with no age would show an authenticated account whose authentication has no age.
    if (account.healthObservedAt === null && account.healthState !== "indeterminate") {
      context.addIssue({
        code: "custom",
        // Pathed at the timestamp: a stored state implies a stored time, so the timestamp is
        // the member that went missing.
        path: ["healthObservedAt"],
        message:
          `\`healthState: "${account.healthState}"\` is the outcome ` +
          `of an observation, so \`healthObservedAt\` cannot ` +
          `be null; only \`indeterminate\` is reachable unobserved`,
      });
    }
  });

/** Remedy for `no_account`: register an account for the provider. */
export interface ProviderRegisterRemedy {
  kind: "register";
  provider: ProviderName;
}

/** Remedy for `no_default`: the person picks one of the listed accounts as the default. */
export interface ProviderChooseDefaultRemedy {
  kind: "choose_default";
  /** The daemon lists the candidates and never picks one. */
  candidateAccountIds: ProviderAccountId[];
}

/** Remedy for a resolved account that is not authenticated: run the provider's own sign-in. */
export interface ProviderSignInRemedy {
  kind: "sign_in";
  /** The resolved account; required because this is the arm where an account resolved. */
  accountId: ProviderAccountId;
}

/**
 * Remedy for `reauth_required` on a token or API-key account: it cannot refresh itself, so the
 * person mints a fresh token at the provider and pastes it; never a sign-in, retry or refresh.
 */
export interface ProviderPasteTokenRemedy {
  kind: "paste_token";
  accountId: ProviderAccountId;
}

/**
 * Remedy for `indeterminate`: nothing wrong can be seen, so the next read may settle it and
 * `providerAccount.probe` asks again. Never a sign-in.
 */
export interface ProviderLookAgainRemedy {
  kind: "look_again";
  accountId: ProviderAccountId;
}

/**
 * The next step shown for a readiness state that is not `authenticated`. `reauth_required` takes
 * `sign_in` or, on a token or API-key account, `paste_token`, so a client renders off `kind`,
 * not `state`.
 */
export type ProviderRemedy =
  | ProviderRegisterRemedy
  | ProviderChooseDefaultRemedy
  | ProviderSignInRemedy
  | ProviderPasteTokenRemedy
  | ProviderLookAgainRemedy;

// The two arms an account whose login is gone takes, kept apart so its own parser and the full
// remedy parser are built from one declaration of each.
const signInRemedySchema = z
  .object({
    kind: z.literal("sign_in"),
    accountId: ProviderAccountIdSchema,
  })
  .strict();
const pasteTokenRemedySchema = z
  .object({
    kind: z.literal("paste_token"),
    accountId: ProviderAccountIdSchema,
  })
  .strict();

/** Parses a {@link ProviderRemedy}, discriminated on `kind`. */
export const ProviderRemedySchema: z.ZodType<ProviderRemedy, ProviderRemedy> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("register"),
        provider: ProviderNameSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("choose_default"),
        // Not `.min(2)`: one account with no default is still `no_default`, and the daemon
        // lists it rather than electing it.
        candidateAccountIds: z.array(ProviderAccountIdSchema).min(1),
      })
      .strict(),
    signInRemedySchema,
    pasteTokenRemedySchema,
    z
      .object({
        kind: z.literal("look_again"),
        accountId: ProviderAccountIdSchema,
      })
      .strict(),
  ],
);

/**
 * The remedy of one account whose login is gone: the provider's own sign-in, or, on a token or
 * API-key account, a freshly minted token pasted in.
 */
export type ProviderLoginExpiredRemedy = ProviderSignInRemedy | ProviderPasteTokenRemedy;

/** Parses a {@link ProviderLoginExpiredRemedy}, discriminated on `kind`. */
export const ProviderLoginExpiredRemedySchema: z.ZodType<
  ProviderLoginExpiredRemedy,
  ProviderLoginExpiredRemedy
> = z.discriminatedUnion("kind", [signInRemedySchema, pasteTokenRemedySchema]);

/** One provider's readiness to start a run, with the remedy when it is not ready. */
export interface ProviderReadiness {
  provider: ProviderName;
  state: ProviderReadinessState;
  /** Present iff resolution reached exactly one account. */
  resolvedAccountId?: ProviderAccountId | undefined;
  /**
   * RFC 3339 UTC of the stored observation `state` was read from. Absent when resolution
   * reached no account or an account with no observation yet; it says nothing about whether
   * a probe ever ran on this node.
   */
  observedAt?: string | undefined;
  /**
   * Required on every state except `authenticated`, which refuses one. Optional in this type
   * because requiredness follows `state`; the parser refuses a missing remedy and one of the
   * wrong kind for the state.
   */
  remedy?: ProviderRemedy | undefined;
}

/**
 * The remedy kinds each readiness state allows: register with nothing registered, choose a
 * default when none is set, the provider's own sign-in for a lost login or a missing home, a
 * fresh pasted token for a token or API-key account's lost login, and a look again when the
 * read could not decide. A total record, so a new state without a remedy fails to compile.
 */
const REMEDY_KINDS_FOR_READINESS_STATE: Readonly<
  Record<ProviderReadinessState, readonly ProviderRemedy["kind"][] | null>
> = {
  authenticated: null,
  // The entry carries no sign-in mode, so which of the two applies is the producer's call.
  reauth_required: ["sign_in", "paste_token"],
  home_missing: ["sign_in"],
  indeterminate: ["look_again"],
  no_account: ["register"],
  no_default: ["choose_default"],
};

/** Parses a {@link ProviderReadiness}; the remedy kind and its account must match the state. */
export const ProviderReadinessSchema: z.ZodType<ProviderReadiness, ProviderReadiness> = z
  .object({
    provider: ProviderNameSchema,
    state: ProviderReadinessStateSchema,
    resolvedAccountId: ProviderAccountIdSchema.optional(),
    observedAt: isoDateTimeSchema.optional(),
    remedy: ProviderRemedySchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const { remedy } = entry;
    const allowedKinds = REMEDY_KINDS_FOR_READINESS_STATE[entry.state];
    if (remedy === undefined) {
      // A state the person must act on renders bare without its remedy.
      if (allowedKinds !== null) {
        context.addIssue({
          code: "custom",
          path: ["remedy"],
          message:
            `\`state: "${entry.state}"\` must carry the ` +
            `${allowedKinds.map((kind) => `\`${kind}\``).join(" or ")} remedy`,
        });
      }
      return;
    }
    if (allowedKinds === null || !allowedKinds.includes(remedy.kind)) {
      context.addIssue({
        code: "custom",
        path: ["remedy", "kind"],
        message:
          allowedKinds === null
            ? `\`state: "${entry.state}"\` needs no action, so it ` +
              `carries no remedy; \`${remedy.kind}\` would disclose ` +
              `a next step for an account that is already usable`
            : `\`state: "${entry.state}"\` calls for the ` +
              `${allowedKinds.map((kind) => `\`${kind}\``).join(" or ")} ` +
              `remedy, not \`${remedy.kind}\``,
      });
      return;
    }
    // A remedy that names an account must name the entry's own resolved account; otherwise the
    // person is pointed at one account to fix another's, or at an account no entry resolved.
    if ("accountId" in remedy && remedy.accountId !== entry.resolvedAccountId) {
      context.addIssue({
        code: "custom",
        path: ["remedy", "accountId"],
        message:
          entry.resolvedAccountId === undefined
            ? `a \`${remedy.kind}\` remedy names an account, so its ` +
              `entry must carry the \`resolvedAccountId\` it belongs to`
            : `the \`${remedy.kind}\` remedy's \`accountId\` ` +
              `must be the entry's own \`resolvedAccountId\``,
      });
    }
  });

/**
 * One quota reading for one limit of one account. `limitId` is the key and `windowMins` is an
 * attribute: a provider can publish several limits that share a window length, so keying on
 * window length would collapse them.
 */
export interface ProviderAccountUsageWindow {
  /** Required because the list reply is one flat array over all accounts. */
  accountId: ProviderAccountId;
  /**
   * The provider's own limit id, verbatim and untrusted. Not a closed union, because the
   * provider's limit set is open. A reading that names no limit takes
   * `PROVIDER_QUOTA_DEFAULT_LIMIT_ID`.
   */
  limitId: string;
  windowMins: number;
  /** The provider's own display label where it publishes one; never parsed, never a key. */
  label?: string | undefined;
  /**
   * Utilization at `observedAt`. Not clamped to 100, because a provider may report
   * over-consumption; renderers clamp for display.
   */
  usedPercent: number;
  /** RFC 3339 UTC where the provider supplies it; absent means unknown. */
  resetsAt?: string | undefined;
  /**
   * RFC 3339 UTC. The ordering key: the newest per `(accountId, limitId)` wins, and `source`
   * breaks exact ties.
   */
  observedAt: string;
  /**
   * The account's `credentialGeneration` when this was read. A home rebuild keeps stored
   * readings (the provider-side allowance keeps running), so a renderer marks a reading from
   * an earlier generation stale.
   */
  observedCredentialGeneration: CredentialGeneration;
  source: ProviderAccountUsageWindowSource;
}

/** The limit id a reading takes when it names none. */
export const PROVIDER_QUOTA_DEFAULT_LIMIT_ID = "default";

/** Parses a {@link ProviderAccountUsageWindow}. */
export const ProviderAccountUsageWindowSchema: z.ZodType<
  ProviderAccountUsageWindow,
  ProviderAccountUsageWindow
> = z
  .object({
    accountId: ProviderAccountIdSchema,
    limitId: wireFreeFormString(
      PROVIDER_QUOTA_LIMIT_ID_MAX_LEN,
      "ProviderAccountUsageWindow.limitId",
    ),
    // Positive: a zero-length window has no reset horizon. The database does not check this.
    windowMins: z.number().int().positive(),
    label: wireFreeFormString(
      PROVIDER_QUOTA_LABEL_MAX_LEN,
      "ProviderAccountUsageWindow.label",
    ).optional(),
    // Floor only, like the column's CHECK; no ceiling because over-consumption is reported.
    usedPercent: z.number().min(0),
    resetsAt: isoDateTimeSchema.optional(),
    observedAt: isoDateTimeSchema,
    observedCredentialGeneration: CredentialGenerationSchema,
    source: ProviderAccountUsageWindowSourceSchema,
  })
  .strict();

/** Request of `providerAccount.list`. */
export interface ProviderAccountListRequest {
  provider?: ProviderName | undefined;
  /**
   * Scopes readiness to one account instead of the provider's default. It exists for a run
   * refused while bound to a per-run account override: without it the remedy would describe
   * the default account, whose home may be healthy. A selector only: an unknown or removed id
   * is refused, never replaced by the default.
   */
  accountId?: ProviderAccountId | undefined;
}

/** Parses a {@link ProviderAccountListRequest}. */
export const ProviderAccountListRequestSchema: z.ZodType<
  ProviderAccountListRequest,
  ProviderAccountListRequest
> = z
  .object({
    provider: ProviderNameSchema.optional(),
    accountId: ProviderAccountIdSchema.optional(),
  })
  .strict();

/** Response of `providerAccount.list`. */
export interface ProviderAccountListResponse {
  accounts: ProviderAccount[];
  /**
   * The stored quota rows, sent on the read because the subscription is a live tail, not a
   * catch-up; a client opened later would otherwise miss them until the next reading. Each
   * keeps the `source` it was observed under, so a stored window may carry `"run"`.
   */
  usageWindows: ProviderAccountUsageWindow[];
  /** Exactly one entry per selected provider, so no client derives readiness itself. */
  readiness: ProviderReadiness[];
}

/** Parses a {@link ProviderAccountListResponse}. */
export const ProviderAccountListResponseSchema: z.ZodType<ProviderAccountListResponse> = z
  .object({
    accounts: z.array(ProviderAccountSchema),
    usageWindows: z.array(ProviderAccountUsageWindowSchema),
    readiness: z.array(ProviderReadinessSchema),
  })
  .strict();

// `providerAccount.subscribe` is a live tail of registry changes on this node. It sends a
// wire-only notification, never an `EventEnvelope`: a node-local registry act has no session,
// and a session event would put node administration in a session's transcript. A client opens
// the subscription before calling `providerAccount.login`, so a completion that races the call
// still arrives. Every notification is a full state update, so seeing one twice is harmless.

/** Request of `providerAccount.subscribe`; empty because the subscription is node-scoped. */
export type ProviderAccountSubscribeRequest = Record<string, never>;

/** Parses a {@link ProviderAccountSubscribeRequest}. */
export const ProviderAccountSubscribeRequestSchema: z.ZodType<
  ProviderAccountSubscribeRequest,
  ProviderAccountSubscribeRequest
> = z.object({}).strict();

const PROVIDER_LOGIN_OUTCOME_VALUES = ["succeeded", "failed", "canceled"] as const;

/** How a brokered sign-in attempt ended. */
export type ProviderLoginOutcome = (typeof PROVIDER_LOGIN_OUTCOME_VALUES)[number];
/**
 * Every `ProviderLoginOutcome`, in declaration order.
 *
 * @consumedBy the sign-in card, which reads `Sign-in did not finish.` when a sign-in fails
 */
export const PROVIDER_LOGIN_OUTCOMES: readonly ProviderLoginOutcome[] =
  PROVIDER_LOGIN_OUTCOME_VALUES;

/** A change to the node's provider-account registry, sent by `providerAccount.subscribe`. */
export type ProviderAccountNotification =
  /** Registered, corrected, default moved, or a stored reading rewritten. */
  | { kind: "account_changed"; account: ProviderAccount }
  | { kind: "account_removed"; accountId: ProviderAccountId }
  /**
   * Correlated on `attemptId`. `succeeded` only means the provider's flow finished, not that
   * the account is authenticated: the daemon then takes a health observation and sends it as
   * `account_changed`. A client that treats this as the verdict would show as ready an
   * account a spawn would refuse.
   */
  | {
      kind: "login_completed";
      attemptId: string;
      accountId: ProviderAccountId;
      outcome: ProviderLoginOutcome;
      /** Text for the person, with no credential material, provider error body or home path. */
      failureReason?: string | undefined;
    }
  | {
      kind: "usage_window_updated";
      accountId: ProviderAccountId;
      window: ProviderAccountUsageWindow;
    };

/** Parses a {@link ProviderAccountNotification}, discriminated on `kind`. */
export const ProviderAccountNotificationSchema: z.ZodType<ProviderAccountNotification> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("account_changed"), account: ProviderAccountSchema }).strict(),
    z.object({ kind: z.literal("account_removed"), accountId: ProviderAccountIdSchema }).strict(),
    z
      .object({
        kind: z.literal("login_completed"),
        attemptId: wireFreeFormString(
          PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
          "ProviderAccountNotification.attemptId",
        ),
        accountId: ProviderAccountIdSchema,
        outcome: z.enum(PROVIDER_LOGIN_OUTCOME_VALUES),
        failureReason: wireFreeFormString(
          PROVIDER_LOGIN_FAILURE_REASON_MAX_LEN,
          "ProviderAccountNotification.failureReason",
        ).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("usage_window_updated"),
        accountId: ProviderAccountIdSchema,
        window: ProviderAccountUsageWindowSchema,
      })
      .strict()
      // The outer `accountId` routes; `window.accountId` is part of the reading, so a live
      // update and a list row key alike. If they differ, a consumer would file the reading
      // under the wrong account, so the notification is refused.
      .superRefine((notification, context) => {
        if (notification.window.accountId !== notification.accountId) {
          context.addIssue({
            code: "custom",
            path: ["window", "accountId"],
            message:
              "usage_window_updated carries a reading for a different " +
              "account than the notification routes to; " +
              "window.accountId must equal the notification's accountId.",
          });
        }
      }),
  ]);
