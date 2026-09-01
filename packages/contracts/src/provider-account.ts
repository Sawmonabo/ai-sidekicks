// Plan-029 T1.1 + T1.4 — the `providerAccount.*` wire surface: the node-local
// provider-account registry, its brokered sign-in pair, its registry-change
// notification union, and its per-limit quota-window shape.
//
// PROVENANCE. The canonical shapes are
// `docs/architecture/contracts/api-payload-contracts.md` §"Plan-029 — Provider
// Accounts And Credential Homes"; the durable columns those shapes project are
// `docs/architecture/schemas/local-sqlite-schema.md` §"Provider Account Tables
// (Plan-029)". This module APPLIES both; it decides neither. Changing a member
// name, an enum member, or a requiredness is a doc edit first.
//
// ----------------------------------------------------------------------------
// The one credential input, and the census that keeps it one
// ----------------------------------------------------------------------------
//
// Credential material crosses this surface on EXACTLY ONE input —
// `ProviderAccountRegisterRequest.nonInteractiveToken` — and on NO output. No
// response and no notification shape declared here carries a token-shaped
// member under any name. That claim is not prose: `PROVIDER_ACCOUNT_WIRE_SHAPES`
// below enumerates every request, response, and notification shape in this
// module, and the contract suite walks it to count credential-accepting inputs
// (must be exactly one, named) and credential-bearing outputs (must be zero).
// A shape added here without a registry entry is caught by the same suite's
// completeness check, so the census cannot go vacuous by omission.
//
// THE ERROR CHANNEL IS THE FOURTH DIRECTION, and this module declares no shape
// for it. A `provideraccount.*` refusal travels as `JsonRpcErrorData`, whose
// `fields` is `Record<string, unknown>` — an untyped hole no schema census can
// close, because there is no schema. The permitted contents are declared in
// prose, per code, in `docs/architecture/contracts/error-contracts.md`
// §"Provider Account"; the guarantee that matters most there is
// `provideraccount.token_class_refused`, which "names which condition failed and
// never quotes, echoes, or excerpts the supplied value". The contract suite
// therefore censuses representative refusal envelopes — each code transcribed
// from those rows, each `fields` shape composed to be consistent with that
// row's prose — by member NAME at any depth and by VALUE against the token
// fixture, so a mapper that echoed the input back fails a test rather than only
// a reading of the docs. Two honest limits: the fixture set is enumerated by
// hand, so a code added to that doc without a fixture is not caught here, and
// the binding enforcement is the daemon's error mapper, which is a later phase.
// Registering the field names as a typed contract belongs to the swap that
// gives them a producer — a declaration whose only consumer is its own test is
// minted ahead of its reader.
//
// ----------------------------------------------------------------------------
// What is response-only, and what deliberately is not
// ----------------------------------------------------------------------------
//
// `credentialGeneration` is daemon-owned and appears on NO request in this
// module: a caller that could assert a generation could assert that a stale
// quota reading or a superseded attention epoch is current.
//
// `accountId` is response-only EXCEPT on two selectors that name an account
// rather than assert one: `ProviderAccountListRequest.accountId` scopes the
// readiness derivation to a named account, and
// `ProviderAccountRegisterRequest.accountId` is the token RE-SUPPLY selector.
// Both are documented in the canonical wire section and in
// `Spec-029 §Non-interactive token registration`; neither mints an identity,
// because a supplied id that names no registered account is refused rather than
// created.
//
// ----------------------------------------------------------------------------
// Where tolerance lives, and where it must not
// ----------------------------------------------------------------------------
//
// `ProviderAuthModeSchema` is a CLOSED union: the daemon is the producer on
// every surface it appears on, so a value outside the union is a composition
// defect and must fail loudly. The tolerance the account plane needs sits one
// layer lower, at the boundary where a provider's own status output is READ —
// `normalizeObservedProviderAuthMode` maps an unrecognized reported mode onto
// the `unknown` arm and never throws, so a vendor adding a mode degrades an
// observation's precision rather than failing the observation closed.
//
// Refs: Plan-029 T1.1, T1.4, I-029-1, I-029-2, I-029-5, I-029-11, I-029-13;
// ADR-014 (tRPC v11 / Standard Schema V1 double-T annotation), ADR-021
// (credential custody ladder), ADR-028 (bounded non-interactive token custody),
// ADR-022 (Zod 4.x).
import { z } from "zod";

import { wireFreeFormString } from "./session.js";

// --------------------------------------------------------------------------
// Length caps
// --------------------------------------------------------------------------
//
// Defense-in-depth bounds at the trust boundary, in the `wireFreeFormString`
// tradition: the transport layer is the authoritative body-size enforcer, and
// these stop a single pathological member long before that limit is reached.
// Every cap here is a wire cap; none of them is a storage constraint, because
// the DDL these shapes project declares no length CHECK on any TEXT column.

/** Daemon-minted opaque account identity; mirrors `NODE_ID_MAX_LEN`. */
export const PROVIDER_ACCOUNT_ID_MAX_LEN = 256;
/** Operator-chosen disambiguation label. */
export const PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN = 256;
/** RFC 5321 §4.5.3.1.3 caps a forward path at 320 octets. */
export const PROVIDER_ACCOUNT_EMAIL_MAX_LEN = 320;
/** Provider-reported organization identifier. */
export const PROVIDER_ACCOUNT_ORG_ID_MAX_LEN = 256;
/** Provider-reported organization display name. */
export const PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN = 256;
/** Filesystem path bound: POSIX `PATH_MAX` on Linux, and above Windows' extended-length limit. */
export const PROVIDER_CREDENTIAL_HOME_PATH_MAX_LEN = 4096;
/** The provider's own first-party sign-in command, carried for DISPLAY only. */
export const PROVIDER_SIGN_IN_INVOCATION_MAX_LEN = 512;
/** Opaque daemon-minted correlation key for one brokered sign-in attempt. */
export const PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN = 256;
/** The provider's verification URL, carried verbatim. */
export const PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN = 2048;
/** Device-code arm: the code the operator types at the verification URI. */
export const PROVIDER_LOGIN_USER_CODE_MAX_LEN = 64;
/** Operator-facing failure text; carries no credential material and no home path. */
export const PROVIDER_LOGIN_FAILURE_REASON_MAX_LEN = 512;
/** The provider's own limit identifier, carried verbatim as an untrusted string. */
export const PROVIDER_QUOTA_LIMIT_ID_MAX_LEN = 128;
/** The provider's own display label for a quota window. */
export const PROVIDER_QUOTA_LABEL_MAX_LEN = 256;
/**
 * Bound on the ADR-028 D2 non-interactive token. Generous because the class is
 * vendor-minted and its encoding is not this layer's to predict; the bound
 * exists so an unbounded body cannot be smuggled through the one member whose
 * value is never logged and so never observable in a diagnostic.
 */
export const PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// Closed enums
// --------------------------------------------------------------------------
//
// Each enum is declared once as a non-exported literal tuple and surfaced twice:
// as the Zod schema the wire parses with, and as a `readonly` array the
// conformance suite reads to pin the member list against the DDL's CHECK list.
// One declaration, two consumers — so the schema and the pin can never drift.

const PROVIDER_NAME_VALUES = ["claude", "codex"] as const;

/**
 * The closed provider set. Byte-identical to the `provider_accounts.provider`
 * CHECK list and to the same closed driver-id union the MCP governance tables
 * use. Deliberately NOT `z.string()`: an account's provider selects which
 * driver, which credential-home layout, and which quota vocabulary apply, so an
 * unrecognized value has no safe interpretation.
 */
export type ProviderName = (typeof PROVIDER_NAME_VALUES)[number];
export const PROVIDER_NAMES: readonly ProviderName[] = PROVIDER_NAME_VALUES;
export const ProviderNameSchema: z.ZodType<ProviderName, ProviderName> =
  z.enum(PROVIDER_NAME_VALUES);

const BILLING_MODE_VALUES = ["subscription", "metered", "unknown"] as const;

/**
 * How an account is charged. `unknown` is the HONEST-ABSENCE arm and is never a
 * synonym for `metered`: it drives cost labeling and never cost derivation, so
 * rendering it as metered would attach a spend claim the daemon cannot support.
 */
export type BillingMode = (typeof BILLING_MODE_VALUES)[number];
export const BILLING_MODES: readonly BillingMode[] = BILLING_MODE_VALUES;
export const BillingModeSchema: z.ZodType<BillingMode, BillingMode> = z.enum(BILLING_MODE_VALUES);

const PROVIDER_ACCOUNT_HEALTH_STATE_VALUES = [
  "authenticated",
  "reauth_required",
  "home_missing",
  "indeterminate",
] as const;

/**
 * The STORED outcome of the last validation of an account: the driver's
 * authentication probe reading together with the credential-home observation
 * taken at that same moment.
 *
 * `indeterminate` is fail-closed — the probe could not decide, or none has ever
 * been taken. It is treated as NOT authenticated and is not itself a failure.
 * The column is nullable and this wire arm is not: a NULL stored reading
 * projects as `indeterminate`, never as authenticated and never as an error.
 */
export type ProviderAccountHealthState = (typeof PROVIDER_ACCOUNT_HEALTH_STATE_VALUES)[number];
export const PROVIDER_ACCOUNT_HEALTH_STATES: readonly ProviderAccountHealthState[] =
  PROVIDER_ACCOUNT_HEALTH_STATE_VALUES;
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
 * The authentication mode the provider's OWN status surface reports for a home
 * — observed, never assumed, and never derived by the daemon from the shape of
 * a credential file.
 *
 * `unknown` is the arm for "observed, and the provider named a mode this build
 * does not recognize". The SCHEMA is closed because the daemon is the producer
 * on every wire surface this type appears on; the tolerance belongs at the
 * observation boundary and is `normalizeObservedProviderAuthMode` below.
 *
 * `oauth_token` is the ADR-028 D2 class and is the mode under which a
 * token-mode account is admitted. The token VALUE is not on this wire.
 */
export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODE_VALUES)[number];
export const PROVIDER_AUTH_MODES: readonly ProviderAuthMode[] = PROVIDER_AUTH_MODE_VALUES;
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
 * The pre-computed answer to the question run admission will ask.
 *
 * Enumerated in FULL rather than aliased off `ProviderAccountHealthState`, so a
 * later health arm cannot silently widen this client-facing union: it widens
 * only in lockstep, and a new health arm requires an explicit readiness arm
 * added here. The first four arms are the resolved account's stored health
 * state verbatim; the last two stand in where resolution reached no account at
 * all. It AUTHORIZES NOTHING — admission re-validates unconditionally.
 */
export type ProviderReadinessState = (typeof PROVIDER_READINESS_STATE_VALUES)[number];
export const PROVIDER_READINESS_STATES: readonly ProviderReadinessState[] =
  PROVIDER_READINESS_STATE_VALUES;
export const ProviderReadinessStateSchema: z.ZodType<
  ProviderReadinessState,
  ProviderReadinessState
> = z.enum(PROVIDER_READINESS_STATE_VALUES);

const PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES = ["probe", "run"] as const;

/**
 * Which sanctioned source produced a quota reading: the deliberate probe verb,
 * or the account-scoped quota event emitted from real traffic. The background
 * health observer is NOT a source and no third value exists — reading quota on
 * one pinned provider leg traverses a path documented to refresh proactively,
 * which the observer is forbidden to do.
 */
export type ProviderAccountUsageWindowSource =
  (typeof PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES)[number];
export const PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCES: readonly ProviderAccountUsageWindowSource[] =
  PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES;
export const ProviderAccountUsageWindowSourceSchema: z.ZodType<
  ProviderAccountUsageWindowSource,
  ProviderAccountUsageWindowSource
> = z.enum(PROVIDER_ACCOUNT_USAGE_WINDOW_SOURCE_VALUES);

// --------------------------------------------------------------------------
// The tolerant observation boundary
// --------------------------------------------------------------------------

/**
 * Map a provider's own reported authentication mode onto the closed
 * `ProviderAuthMode` union. NEVER throws — a vendor adding a mode must degrade
 * an observation's precision, not fail the observation closed.
 *
 * Three outcomes, and the distinction between the last two is the point:
 *   - `null` — nothing was reported. Not observed, which is not the same as
 *     observed-and-unrecognized and must not be recorded as `unknown`.
 *   - a union member — the provider named a mode this build recognizes.
 *   - `"unknown"` — the provider named something, and this build does not
 *     recognize it. The observation still stands; only its precision is lost.
 *
 * A blank or whitespace-only report names no mode, so it reads as absence: the
 * provider supplied a field with nothing in it, which is indistinguishable from
 * having supplied no field.
 *
 * Accepts `unknown` deliberately — the caller's input is a value parsed out of
 * a provider's untyped status output, and narrowing it is this function's job.
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

// --------------------------------------------------------------------------
// ProviderAccountId — daemon-minted opaque brand (NOT a UUID)
// --------------------------------------------------------------------------
//
// `account_id` is `TEXT PRIMARY KEY` and is daemon-minted, opaque, and
// immutable. It is deliberately NOT derived from credential material, an email
// address, a subscription identifier, or a filesystem path: those rotate, and an
// identity that rotates cannot key historical spend (I-029-1). No client,
// driver, or renderer parses it — it selects a credential environment and
// nothing else.
//
// Non-UUID, so it composes `.brand()` inline in the `node-id.ts` /
// `EventCursorSchema` idiom rather than going through `brandedUuidIdSchema`.
// The `z.ZodType<T, T>` double-T annotation is required, not decorative: this
// schema composes into REQUEST schemas whose Standard-Schema-V1 input inference
// must resolve to `ProviderAccountId` rather than `unknown` (ADR-014).

export type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
export const ProviderAccountIdSchema: z.ZodType<ProviderAccountId, ProviderAccountId> = z
  .string()
  .min(1)
  .max(PROVIDER_ACCOUNT_ID_MAX_LEN)
  .brand<"ProviderAccountId">() as unknown as z.ZodType<ProviderAccountId, ProviderAccountId>;

// --------------------------------------------------------------------------
// CredentialGeneration
// --------------------------------------------------------------------------

/** The generation a freshly registered account is born at (I-029-2). */
export const CREDENTIAL_GENERATION_MIN = 1;

/**
 * Monotonic per account, starting at `CREDENTIAL_GENERATION_MIN` and strictly
 * increasing at each credential-home lifecycle transition. It never decreases
 * and never resets, including across a home reset.
 *
 * A plain `number` rather than a brand, matching the canonical wire, which
 * types every occurrence `credentialGeneration: number`. The constraint that
 * matters is the parser's, not the nominal type's: `.int()` because a
 * fractional generation compares unequal to every stored value, and the floor
 * because generation 0 would order BEFORE a freshly registered account and let
 * a fabricated reading read as newer than the account it describes.
 */
export type CredentialGeneration = number;
export const CredentialGenerationSchema: z.ZodType<CredentialGeneration, CredentialGeneration> = z
  .number()
  .int()
  .min(CREDENTIAL_GENERATION_MIN);

// --------------------------------------------------------------------------
// ProviderAccount — the registry record as projected onto the wire
// --------------------------------------------------------------------------
//
// A PROJECTION, not a row mirror. Four column groups are deliberately absent:
//   * `credential_home_path` — the home reaches an operator's screen through
//     `ProviderSignInRemedy.credentialHomePath` and nowhere else. On every
//     surface a session participant can reach, `credential_home_path` names a
//     column and nothing else.
//   * `created_at` / `updated_at` — row bookkeeping with no wire consumer.
//     `updated_at` moves on ANY mutation, so surfacing it beside the health
//     pair would invite a reader to treat a relabel as a fresh observation.
//   * `removal_intent` — the durable half of the cross-store removal protocol.
//     An intent-marked row is refused at admission and is not a state a client
//     renders.
//   * `last_refresh_observed_at` — an input to the re-login estimate, which is
//     what the wire carries instead.
// And one member has no column at all: `expectedReloginAtEstimate` is DERIVED,
// mode-dispatched from `loggedInAt` at read time.

export interface ProviderAccount {
  accountId: ProviderAccountId;
  provider: ProviderName;
  /** Operator-chosen; participant-adjacent PII. Never provider-reported. */
  displayLabel: string;
  credentialGeneration: CredentialGeneration;
  billingMode: BillingMode;
  /**
   * Provider-REPORTED identity, present only where a health observation
   * surfaced it. Each member is INDEPENDENTLY optional because a provider may
   * report any subset, and an absent value stays absent rather than defaulting.
   */
  observedAccountEmail?: string | undefined;
  observedAccountOrgId?: string | undefined;
  observedAccountOrgName?: string | undefined;
  /** Exactly one per provider, enforced by a partial unique index (I-029-5). */
  isDefault: boolean;
  healthState: ProviderAccountHealthState;
  /**
   * The OTHER HALF of the stored observation pair — `health_observed_at`, which
   * the table-level `CHECK ((health_state IS NULL) = (health_observed_at IS
   * NULL))` holds set and cleared together with the reading it timestamps.
   *
   * `null` means no observation has ever been recorded for this account, which
   * is the one thing `healthState` alone cannot say: a never-observed account
   * and a probe that could not decide both project `indeterminate`, and only
   * this member separates them.
   *
   * It rides the account record rather than only `ProviderReadiness.observedAt`
   * because readiness is derived per PROVIDER from the resolved account, so
   * every non-default account in a list reply — and every `account_changed`
   * notification, which carries this shape — would otherwise carry a state with
   * no age and no surface could apply a freshness test. Carried verbatim from
   * the column; never re-derived, and never substituted from `updated_at`.
   */
  healthObservedAt: string | null;
  /** `null` until a health observation has named a mode. */
  observedAuthMode: ProviderAuthMode | null;
  /**
   * RFC 3339 UTC of the moment this home's credential was ISSUED — not the
   * moment it was registered. `null` where neither a brokered sign-in nor a
   * token registration produced an issuance anchor.
   */
  loggedInAt: string | null;
  /**
   * An ESTIMATE, and the name says so. Mode-dispatched from `loggedInAt` by the
   * provider's published issuance interval; `null` whenever `loggedInAt` or
   * `observedAuthMode` is null, because an estimate with no anchor is a
   * fabrication. A renderer MUST present it as an approximation, never as a
   * deadline the daemon can vouch for.
   */
  expectedReloginAtEstimate: string | null;
  /**
   * `false` = the operator silenced the BACKGROUND observer for this account.
   * The deliberate probe verb and spawn validation still write the stored pair,
   * because both are acts someone explicitly asked for.
   */
  probeEnabled: boolean;
}

export const ProviderAccountSchema: z.ZodType<ProviderAccount, ProviderAccount> = z
  .object({
    accountId: ProviderAccountIdSchema,
    provider: ProviderNameSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccount.displayLabel",
    ),
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
    isDefault: z.boolean(),
    healthState: ProviderAccountHealthStateSchema,
    healthObservedAt: z.iso.datetime({ offset: true }).nullable(),
    // `.nullable()` and NOT `.optional()`: the canonical shape types these as
    // `T | null`, so the member is always present and its absence of an
    // observation is spelled explicitly. An optional member would make
    // "unobserved" and "the producer forgot" the same value on the wire.
    observedAuthMode: ProviderAuthModeSchema.nullable(),
    loggedInAt: z.iso.datetime({ offset: true }).nullable(),
    expectedReloginAtEstimate: z.iso.datetime({ offset: true }).nullable(),
    probeEnabled: z.boolean(),
  })
  .strict()
  .superRefine((account, ctx) => {
    // A NULL observation timestamp means NO observation has ever been taken —
    // the durable pair moves together under
    // `CHECK ((health_state IS NULL) = (health_observed_at IS NULL))`, and a NULL
    // stored pair projects as `indeterminate`. So `indeterminate` is the ONLY arm
    // reachable without a timestamp, and it is deliberately reachable with one
    // too: "never probed" and "probed, and the probe could not decide" are
    // different facts about the same account, and the timestamp is what tells
    // them apart. The other three arms are OUTCOMES of an observation and cannot
    // exist without the moment they were read at; admitting one with a null
    // timestamp would let a client render an authenticated account whose
    // authentication has no age, which is the reading `expectedReloginAtEstimate`
    // and the staleness banner both depend on.
    if (account.healthObservedAt === null && account.healthState !== "indeterminate") {
      ctx.addIssue({
        code: "custom",
        // Pathed at the TIMESTAMP: the durable CHECK means a stored
        // `authenticated` implies a stored observation time, so the member that
        // went missing on the way to the wire is the timestamp, not the state.
        path: ["healthObservedAt"],
        message: `\`healthState: "${account.healthState}"\` is the outcome of an observation, so \`healthObservedAt\` cannot be null; only \`indeterminate\` is reachable unobserved`,
      });
    }
  });

// --------------------------------------------------------------------------
// Readiness and its remedy union
// --------------------------------------------------------------------------

/**
 * Operator-facing guidance that happens to travel structured.
 *
 * A UNION rather than one shape, because the three non-authenticated classes
 * have three different next actions with three different PRODUCIBLE field sets:
 * `no_account` has no credential home to name at all, and `no_default`
 * deliberately resolved to none of several homes, so a single sign-in shape
 * would have required inventing a path or arbitrarily electing an account —
 * exactly the arbitrary selection I-029-5 exists to prevent.
 *
 * The discriminant is `kind` and it is NOT redundant with `state`:
 * `reauth_required`, `home_missing`, and `indeterminate` all map to `sign_in`,
 * so the mapping is many-to-one and a client renders off `kind`.
 */
export interface ProviderRegisterRemedy {
  kind: "register";
  provider: ProviderName;
}

export interface ProviderChooseDefaultRemedy {
  kind: "choose_default";
  /** The daemon names the candidates and refuses to elect one. */
  candidateAccountIds: ProviderAccountId[];
}

export interface ProviderSignInRemedy {
  kind: "sign_in";
  /** REQUIRED on this arm: it is the arm where an account resolved. */
  accountId: ProviderAccountId;
  /**
   * The provider's OWN first-party sign-in command, for DISPLAY. The daemon
   * never executes it, and this is not a shell string a client is invited to
   * run on the operator's behalf.
   */
  signInInvocation: string;
  /** The home that invocation authenticates INTO; display-only. */
  credentialHomePath: string;
}

export type ProviderRemedy =
  | ProviderRegisterRemedy
  | ProviderChooseDefaultRemedy
  | ProviderSignInRemedy;

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
        // NOT `.min(2)`: a one-account no-default state is still `no_default`,
        // and the daemon lists whatever exists rather than electing the only
        // candidate. `.min(1)` is the honest floor — this arm is reached only
        // because accounts exist.
        candidateAccountIds: z.array(ProviderAccountIdSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("sign_in"),
        accountId: ProviderAccountIdSchema,
        signInInvocation: wireFreeFormString(
          PROVIDER_SIGN_IN_INVOCATION_MAX_LEN,
          "ProviderSignInRemedy.signInInvocation",
        ),
        // ABSOLUTENESS IS DELIBERATELY NOT SPELLED HERE, on the standing
        // `RepoAttachRequest.localPath` precedent: a `startsWith("/")` test
        // refuses every Windows path (`C:\Users\...\.claude`), and Windows is a
        // V1 tier. What this layer enforces is what it can enforce everywhere —
        // non-empty, not whitespace-only, NUL-free, and bounded. The
        // home-path rules that need a filesystem (absolute, daemon-owned,
        // outside any repo working tree, unique across accounts) belong to the
        // daemon's credential-home service, which owns the only context in
        // which they are decidable.
        credentialHomePath: wireFreeFormString(
          PROVIDER_CREDENTIAL_HOME_PATH_MAX_LEN,
          "ProviderSignInRemedy.credentialHomePath",
        ),
      })
      .strict(),
  ],
);

export interface ProviderReadiness {
  provider: ProviderName;
  state: ProviderReadinessState;
  /** Present iff resolution reached exactly one account. */
  resolvedAccountId?: ProviderAccountId | undefined;
  /**
   * RFC 3339 UTC of the STORED observation this entry's state was read from.
   * Absent in exactly two cases, both about THIS resolution rather than about
   * the node's probe history: resolution reached no account, or it reached an
   * account whose observation pair is still unset. Absence therefore never
   * means "no probe has ever been taken on this node".
   */
  observedAt?: string | undefined;
  /**
   * Schema-optional, PRODUCER-OBLIGATED: the daemon populates it on every
   * non-authenticated arm and omits it on `authenticated`. Optional at parse
   * because the state alone does not make REQUIREDNESS expressible to a strict
   * parser without splitting this interface per arm; the obligation to supply
   * one is the producer's and is tested per arm.
   *
   * What the parser does enforce is the other half: a remedy that IS present
   * must be the one its state calls for, per `REMEDY_KIND_FOR_READINESS_STATE`
   * below. Absence stays parseable; a WRONG remedy does not.
   */
  remedy?: ProviderRemedy | undefined;
}

/**
 * The state -> remedy-kind mapping `Spec-029 §Node provider readiness and the
 * sign-in handoff` states in prose: "three different actions, not one" — with
 * nothing registered, register; with accounts registered and none default,
 * choose a default; with exactly one account resolved but not authenticated,
 * the provider's own first-party sign-in against THAT account's home. `null` is
 * the fourth case and is not a fourth action: `authenticated` needs nothing
 * done, so a remedy on it is not merely redundant but wrong — it would put a
 * credential-home path and a sign-in invocation on the one entry whose account
 * requires neither.
 *
 * A TOTAL record rather than a switch: adding a readiness arm without deciding
 * its remedy is then a compile error here rather than a hole that parses.
 */
const REMEDY_KIND_FOR_READINESS_STATE: Readonly<
  Record<ProviderReadinessState, ProviderRemedy["kind"] | null>
> = {
  authenticated: null,
  reauth_required: "sign_in",
  home_missing: "sign_in",
  indeterminate: "sign_in",
  no_account: "register",
  no_default: "choose_default",
};

export const ProviderReadinessSchema: z.ZodType<ProviderReadiness, ProviderReadiness> = z
  .object({
    provider: ProviderNameSchema,
    state: ProviderReadinessStateSchema,
    resolvedAccountId: ProviderAccountIdSchema.optional(),
    observedAt: z.iso.datetime({ offset: true }).optional(),
    remedy: ProviderRemedySchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const { remedy } = entry;
    if (remedy === undefined) {
      // Requiredness stays the producer's obligation — see the member comment.
      return;
    }
    const expectedKind = REMEDY_KIND_FOR_READINESS_STATE[entry.state];
    if (remedy.kind !== expectedKind) {
      ctx.addIssue({
        code: "custom",
        path: ["remedy", "kind"],
        message:
          expectedKind === null
            ? `\`state: "${entry.state}"\` needs no action, so it carries no remedy; \`${remedy.kind}\` would disclose a next step for an account that is already usable`
            : `\`state: "${entry.state}"\` calls for the \`${expectedKind}\` remedy, not \`${remedy.kind}\``,
      });
      return;
    }
    // The `sign_in` arm is the arm where resolution reached exactly one account,
    // and its `accountId` names the home its invocation authenticates INTO. If
    // that id disagreed with the entry's own `resolvedAccountId` the operator
    // would be pointed at one account's credential home to fix another's —
    // exactly the arbitrary cross-account election I-029-5 exists to prevent,
    // arriving as guidance instead of as a binding. Checked in both directions:
    // a `sign_in` remedy on an entry that resolved NO account has a home path
    // that belongs to no entry at all.
    if (remedy.kind === "sign_in" && remedy.accountId !== entry.resolvedAccountId) {
      ctx.addIssue({
        code: "custom",
        path: ["remedy", "accountId"],
        message:
          entry.resolvedAccountId === undefined
            ? "a `sign_in` remedy names a credential home, so its entry must carry the `resolvedAccountId` that home belongs to"
            : "the `sign_in` remedy's `accountId` must be the entry's own `resolvedAccountId`",
      });
    }
  });

// --------------------------------------------------------------------------
// ProviderAccountUsageWindow — the per-limit quota reading (I-029-13)
// --------------------------------------------------------------------------
//
// `limitId` IS THE KEY and `windowMins` is an ATTRIBUTE of the reading. The
// pinned Claude surface publishes five limit identifiers of which THREE share a
// 10080-minute window, so an `(account, windowMins)` key silently collapses them
// and the survivor depends on arrival order.

export interface ProviderAccountUsageWindow {
  /**
   * REQUIRED and not inferable from position: the read returns one flat array
   * across every registered account, and two accounts of one provider can
   * publish the same `limitId`.
   */
  accountId: ProviderAccountId;
  /**
   * The provider's own limit identifier, carried verbatim as an untrusted
   * provider-adjacent string. NOT a closed union — the limit vocabulary is open
   * and versioned, and a closed union would refuse a reading the moment a
   * vendor adds a window. A reading that names no limit takes the reserved
   * value `PROVIDER_QUOTA_DEFAULT_LIMIT_ID`.
   */
  limitId: string;
  windowMins: number;
  /** The provider's own display label where it publishes one; never parsed, never a key. */
  label?: string | undefined;
  /**
   * Utilization at `observedAt`. NOT clamped to 100 on the wire: a provider may
   * report over-consumption against a soft limit, and clamping would silently
   * misreport it. Renderers clamp for display.
   */
  usedPercent: number;
  /** RFC 3339 UTC where the provider supplies it; absent = unknown, never "now" and never "never". */
  resetsAt?: string | undefined;
  /**
   * RFC 3339 UTC. THE ORDERING KEY: newest `observedAt` wins per
   * `(accountId, limitId)`, and `source` breaks ONLY exact ties.
   */
  observedAt: string;
  /**
   * The account's `credentialGeneration` when this reading was taken. A
   * credential-home rebuild does NOT clear stored readings — the provider-side
   * allowance keeps running while the home is empty — so a renderer compares
   * this against the account's current generation and renders a behind-
   * generation reading as STALE rather than current.
   */
  observedCredentialGeneration: CredentialGeneration;
  source: ProviderAccountUsageWindowSource;
}

/**
 * The reserved identifier a reading that names no limit takes, so a provider
 * publishing a single window needs no special case and the pre-amendment
 * single-window shape stays valid as the degenerate case.
 */
export const PROVIDER_QUOTA_DEFAULT_LIMIT_ID = "default";

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
    // `.positive()` beyond `.int()`: a zero-length window has no reset horizon
    // and a negative one is not a duration. The DDL constrains neither, so this
    // is the wire's own guard rather than a mirror of one.
    windowMins: z.number().int().positive(),
    label: wireFreeFormString(
      PROVIDER_QUOTA_LABEL_MAX_LEN,
      "ProviderAccountUsageWindow.label",
    ).optional(),
    // Floor only, mirroring the `CHECK(used_percent >= 0)` the column carries.
    // No ceiling, deliberately — see the member comment.
    usedPercent: z.number().min(0),
    resetsAt: z.iso.datetime({ offset: true }).optional(),
    observedAt: z.iso.datetime({ offset: true }),
    observedCredentialGeneration: CredentialGenerationSchema,
    source: ProviderAccountUsageWindowSourceSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.list
// --------------------------------------------------------------------------

export interface ProviderAccountListRequest {
  provider?: ProviderName | undefined;
  /**
   * Scopes the readiness derivation to ONE account instead of the provider's
   * default. It exists for a single caller: a run refused on the account plane
   * while bound to a per-run account override. Without it the post-refusal
   * remedy would necessarily describe the provider DEFAULT — a different
   * account from the one that failed, whose home may be entirely healthy — and
   * the operator would be handed a remedy for something that is not broken.
   *
   * A SELECTOR, never an assertion: an unknown or removed id refuses rather
   * than silently falling back to the default, and it mints nothing.
   */
  accountId?: ProviderAccountId | undefined;
}

export const ProviderAccountListRequestSchema: z.ZodType<
  ProviderAccountListRequest,
  ProviderAccountListRequest
> = z
  .object({
    provider: ProviderNameSchema.optional(),
    accountId: ProviderAccountIdSchema.optional(),
  })
  .strict();

export interface ProviderAccountListResponse {
  accounts: ProviderAccount[];
  /**
   * The durable quota rows, delivered on the READ because the subscription is a
   * live tail and not a snapshot replay — without this a client opened after a
   * reading, or after a daemon restart, could not reach the stored windows until
   * another probe or run happened to produce an update. Entries carry the
   * provenance they were OBSERVED under, so a stored window may legitimately
   * carry `source: "run"`.
   */
  usageWindows: ProviderAccountUsageWindow[];
  /**
   * REQUIRED, not additive-optional: a reply that could omit readiness would
   * push every client back into deriving it locally, which is the defect this
   * member exists to remove. Exactly one entry per provider the request selects
   * — never zero, never two.
   */
  readiness: ProviderReadiness[];
}

export const ProviderAccountListResponseSchema: z.ZodType<ProviderAccountListResponse> = z
  .object({
    accounts: z.array(ProviderAccountSchema),
    usageWindows: z.array(ProviderAccountUsageWindowSchema),
    readiness: z.array(ProviderReadinessSchema),
  })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.register
// --------------------------------------------------------------------------

export interface ProviderAccountRegisterRequest {
  provider: ProviderName;
  displayLabel: string;
  billingMode: BillingMode;
  makeDefault?: boolean | undefined;
  /**
   * RE-SUPPLY SELECTOR, not an identity assertion. Supplied, this means
   * "replace the sealed token on THIS account" and `provider` must match the
   * stored row; omitted, this is an ordinary registration and the daemon mints
   * a new identity.
   *
   * It exists because the terminal `reauth_required` remedy is to mint a fresh
   * token and re-supply it, and deregister-then-register would daemon-mint a
   * NEW immutable identity — discarding the spend, quota, and attention history
   * keyed to the account the operator is trying to repair.
   *
   * A supplied id that names no registered account is REFUSED, never created,
   * so this member cannot be used to assert an identity of the caller's
   * choosing (I-029-1).
   *
   * NEVER ADMITTED ALONE. A re-supply with nothing to supply is not a request
   * this verb can serve: it is not a registration (an identity already exists)
   * and not a replacement (no token accompanies it). Admitting it would leave
   * the caller's intent to be guessed downstream, and the cheapest guess is the
   * wrong one — a silent no-op reported as a successful registration. This
   * member's presence therefore REQUIRES `nonInteractiveToken`, refused at the
   * parse boundary rather than in a handler. The converse is deliberately
   * unconstrained: a token with no `accountId` is the ordinary token-mode
   * registration of a new account.
   */
  accountId?: ProviderAccountId | undefined;
  /**
   * THE ONE CREDENTIAL-ACCEPTING INPUT ON THIS WIRE (ADR-028 D2). Optional:
   * omitted is the ordinary registration, and the account authenticates through
   * `providerAccount.login` or the operator's own out-of-band sign-in.
   *
   * WRITE-ONLY. This value is on no response in this module, is never logged,
   * never echoed to a terminal, never rendered, never placed in an error
   * message or a diagnostic dump, and never carried in an argument vector (an
   * argv is readable by any process running as the same user). A transport that
   * logs request bodies MUST redact this member by name — see
   * `PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS`, which exists so that redaction is
   * driven by a declaration rather than by each transport re-deriving the list.
   *
   * Admitted only under ADR-028's four conjunctive conditions and sealed
   * through the ADR-021 ladder; it is never written into the credential home,
   * because daemon-owned bytes in provider-owned space are indistinguishable to
   * every later reader.
   */
  nonInteractiveToken?: string | undefined;
}

export const ProviderAccountRegisterRequestSchema: z.ZodType<
  ProviderAccountRegisterRequest,
  ProviderAccountRegisterRequest
> = z
  .object({
    provider: ProviderNameSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccountRegisterRequest.displayLabel",
    ),
    billingMode: BillingModeSchema,
    makeDefault: z.boolean().optional(),
    accountId: ProviderAccountIdSchema.optional(),
    // `wireFreeFormString` rather than a bare `z.string()`: the NUL-byte guard
    // is load-bearing on a value bound for a child process's environment, where
    // an embedded NUL truncates rather than errors. `.strict()` on the object is
    // what keeps a caller from smuggling `credentialGeneration` or any other
    // daemon-owned member alongside it.
    nonInteractiveToken: wireFreeFormString(
      PROVIDER_NON_INTERACTIVE_TOKEN_MAX_LEN,
      "ProviderAccountRegisterRequest.nonInteractiveToken",
    ).optional(),
  })
  .strict()
  // `accountId` is the RE-SUPPLY selector, so it is meaningless without the
  // value being re-supplied. The two members stay independently optional at the
  // field level because either may legitimately be absent on its own; only the
  // combination is constrained, which is a cross-field rule and therefore lives
  // here rather than on either member. Refused against `nonInteractiveToken`:
  // that is the member the caller must add, and the id it names is not the
  // mistake.
  .superRefine((request, ctx) => {
    if (request.accountId !== undefined && request.nonInteractiveToken === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["nonInteractiveToken"],
        message:
          "accountId selects an account whose sealed token is to be replaced, so a request carrying it must also carry nonInteractiveToken; omit accountId to register a new account instead.",
      });
    }
  });

export interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

export const ProviderAccountRegisterResponseSchema: z.ZodType<ProviderAccountRegisterResponse> = z
  .object({ account: ProviderAccountSchema })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.update
// --------------------------------------------------------------------------
//
// NOT UPDATABLE, by omission from the request and enforced on write:
// `provider` (an account does not change vendor), `credentialHomePath`
// (rebinding a registration to a different home would silently re-point
// historical spend at other credentials), `credentialGeneration` (daemon-owned
// — a descriptive correction is not a credential event), and `isDefault`, which
// has its own verb whose partial-unique-index race semantics this verb must not
// duplicate.

export interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  /** Omitted = unchanged. */
  displayLabel?: string | undefined;
  /** Omitted = unchanged; this is how `unknown` is resolved to a declared mode. */
  billingMode?: BillingMode | undefined;
  /**
   * The durable per-account opt-out for the background observer. Carried on the
   * existing update verb rather than as a dedicated verb: it is an ordinary
   * mutable account preference. Omitted = unchanged; the column default is
   * enabled, so silence never silences an observer.
   */
  probeEnabled?: boolean | undefined;
}

export const ProviderAccountUpdateRequestSchema: z.ZodType<
  ProviderAccountUpdateRequest,
  ProviderAccountUpdateRequest
> = z
  .object({
    accountId: ProviderAccountIdSchema,
    displayLabel: wireFreeFormString(
      PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
      "ProviderAccountUpdateRequest.displayLabel",
    ).optional(),
    billingMode: BillingModeSchema.optional(),
    probeEnabled: z.boolean().optional(),
  })
  .strict();

export interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
}

export const ProviderAccountUpdateResponseSchema: z.ZodType<ProviderAccountUpdateResponse> = z
  .object({ account: ProviderAccountSchema })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.remove
// --------------------------------------------------------------------------

export interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountRemoveRequestSchema: z.ZodType<
  ProviderAccountRemoveRequest,
  ProviderAccountRemoveRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  /**
   * `z.literal(true)` and not `z.boolean()`: removal has no partial success. A
   * `removed: false` reply would be a refusal wearing a success envelope, and
   * every refusal on this verb is a typed error instead.
   */
  removed: true;
}

export const ProviderAccountRemoveResponseSchema: z.ZodType<ProviderAccountRemoveResponse> = z
  .object({ accountId: ProviderAccountIdSchema, removed: z.literal(true) })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.setDefault
// --------------------------------------------------------------------------

export interface ProviderAccountSetDefaultRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountSetDefaultRequestSchema: z.ZodType<
  ProviderAccountSetDefaultRequest,
  ProviderAccountSetDefaultRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountSetDefaultResponse {
  /**
   * The account AFTER the write, and `isDefault` on it is pinned `true` by the
   * schema below. The pin is the same argument `ProviderAccountRemoveResponse`
   * makes with `z.literal(true)`: this verb has no partial success, so an
   * `isDefault: false` reply would be a refusal wearing a success envelope, and
   * every refusal on this verb is a typed error instead
   * (`provideraccount.unknown`, `permission_denied`, `default_conflict`).
   *
   * It is a runtime refinement rather than a narrowed TYPE because the account
   * projection is shared: `ProviderAccount & { isDefault: true }` here would
   * fork the shape every other reply returns, and a client would then hold two
   * incompatible account types for one registry row.
   */
  account: ProviderAccount;
}

export const ProviderAccountSetDefaultResponseSchema: z.ZodType<ProviderAccountSetDefaultResponse> =
  z
    .object({ account: ProviderAccountSchema })
    .strict()
    .superRefine((response, ctx) => {
      if (!response.account.isDefault) {
        ctx.addIssue({
          code: "custom",
          path: ["account", "isDefault"],
          message:
            "`providerAccount.setDefault` returns the account it made default, so `isDefault` cannot be false on a success reply",
        });
      }
    });

// --------------------------------------------------------------------------
// providerAccount.resetCredentialHome
// --------------------------------------------------------------------------
//
// Rebuilds an account's credential home from empty so the operator can
// authenticate into it again. It is a credential-home lifecycle transition, so
// it BUMPS `credentialGeneration` and never resets it — which is what lets a
// stale consumer still order two readings across the rebuild. Identity survives
// untouched, so the account keeps its spend history, and its stored quota
// readings are kept for the same reason: the provider-side allowance kept
// running while the home was empty. The stored health pair is the opposite
// case — the bump invalidates it, which is why `healthState` is returned here.

export interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountResetCredentialHomeRequestSchema: z.ZodType<
  ProviderAccountResetCredentialHomeRequest,
  ProviderAccountResetCredentialHomeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  /** The post-reset generation; strictly greater than the pre-reset value. */
  credentialGeneration: CredentialGeneration;
  /** Expected `reauth_required` until the operator authenticates. */
  healthState: ProviderAccountHealthState;
}

export const ProviderAccountResetCredentialHomeResponseSchema: z.ZodType<ProviderAccountResetCredentialHomeResponse> =
  z
    .object({
      accountId: ProviderAccountIdSchema,
      credentialGeneration: CredentialGenerationSchema,
      healthState: ProviderAccountHealthStateSchema,
    })
    .strict();

// --------------------------------------------------------------------------
// providerAccount.probe
// --------------------------------------------------------------------------

export interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountProbeRequestSchema: z.ZodType<
  ProviderAccountProbeRequest,
  ProviderAccountProbeRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  /** The generation the probe observed; a later bump invalidates this reading. */
  credentialGeneration: CredentialGeneration;
}

export const ProviderAccountProbeResponseSchema: z.ZodType<ProviderAccountProbeResponse> = z
  .object({
    accountId: ProviderAccountIdSchema,
    healthState: ProviderAccountHealthStateSchema,
    credentialGeneration: CredentialGenerationSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// providerAccount.login / providerAccount.loginCancel
// --------------------------------------------------------------------------
//
// Brokered interactive sign-in (ADR-028 D1). The daemon constructs the
// invocation, spawns the provider's UNMODIFIED binary with this account's home
// pinned, and reads nothing the flow writes. What returns is what the provider
// emits for the OPERATOR to act on, plus an opaque daemon-minted attempt id.
//
// The shape MIRRORS THE PROVIDER'S OWN, deliberately: one pinned login-start
// returns either an authorization URL or a device code with its verification
// URL, and the other prints a URL and accepts a pasted code. A provider arm
// emitting neither cannot be brokered and is refused rather than spawning a
// flow the operator cannot finish.

export interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}

export const ProviderAccountLoginRequestSchema: z.ZodType<
  ProviderAccountLoginRequest,
  ProviderAccountLoginRequest
> = z.object({ accountId: ProviderAccountIdSchema }).strict();

export interface ProviderAccountLoginResponse {
  /** Opaque, daemon-minted, single-use; the correlation key for cancel and for completion. */
  attemptId: string;
  /** Where the operator completes the flow — the provider's own URL, verbatim. */
  verificationUri: string;
  /** Present on a device-code arm; the operator types it at `verificationUri`. */
  userCode?: string | undefined;
  /**
   * RFC 3339 UTC, where the provider bounds the attempt. Absent = the provider
   * published no bound, or the value failed the daemon's parse-and-validate
   * step and was OMITTED rather than surfaced. It bounds an attempt and is not
   * provider state: it carries no OAuth, PKCE, or credential field.
   */
  expiresAt?: string | undefined;
}

export const ProviderAccountLoginResponseSchema: z.ZodType<ProviderAccountLoginResponse> = z
  .object({
    attemptId: wireFreeFormString(
      PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
      "ProviderAccountLoginResponse.attemptId",
    ),
    // `z.url()` and not a free-form string: this value is handed to an operator
    // to open, so a non-URL here is a composition defect that must fail at the
    // seam rather than reach a browser. The length cap stays as
    // defense-in-depth against a pathological query string.
    verificationUri: z.url().max(PROVIDER_LOGIN_VERIFICATION_URI_MAX_LEN),
    userCode: wireFreeFormString(
      PROVIDER_LOGIN_USER_CODE_MAX_LEN,
      "ProviderAccountLoginResponse.userCode",
    ).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}

export const ProviderAccountLoginCancelRequestSchema: z.ZodType<
  ProviderAccountLoginCancelRequest,
  ProviderAccountLoginCancelRequest
> = z
  .object({
    attemptId: wireFreeFormString(
      PROVIDER_LOGIN_ATTEMPT_ID_MAX_LEN,
      "ProviderAccountLoginCancelRequest.attemptId",
    ),
  })
  .strict();

const PROVIDER_LOGIN_CANCEL_STATUS_VALUES = ["cancelled", "notFound"] as const;

/**
 * Cancellation is a FIRST-CLASS OUTCOME, not an abandonment: a broker that
 * could only be abandoned would leave a provider-side login slot occupied until
 * it timed out. `notFound` is the honest arm for an attempt that already
 * completed, already cancelled, or never existed — it is NOT an error, because
 * a client racing a completion should not see a refusal for losing the race.
 */
export type ProviderLoginCancelStatus = (typeof PROVIDER_LOGIN_CANCEL_STATUS_VALUES)[number];
export const PROVIDER_LOGIN_CANCEL_STATUSES: readonly ProviderLoginCancelStatus[] =
  PROVIDER_LOGIN_CANCEL_STATUS_VALUES;

export interface ProviderAccountLoginCancelResponse {
  status: ProviderLoginCancelStatus;
}

export const ProviderAccountLoginCancelResponseSchema: z.ZodType<ProviderAccountLoginCancelResponse> =
  z.object({ status: z.enum(PROVIDER_LOGIN_CANCEL_STATUS_VALUES) }).strict();

// --------------------------------------------------------------------------
// providerAccount.subscribe
// --------------------------------------------------------------------------
//
// A read-shaped live tail of registry changes for this node. It carries a
// WIRE-ONLY notification and NEVER an `EventEnvelope`: the provider-account
// registry is un-evented by design, because a node-local operator act on a
// node-local registry has no session to belong to and minting a session event
// type for it would put node administration into a session's audit timeline.
//
// Ordering: a client opens the subscription BEFORE calling
// `providerAccount.login`, so registration is live before the flow starts and a
// completion concurrent with the call arrives on the stream rather than falling
// between them. Re-observation is harmless — every notification is a re-entrant
// state update, not a delta.

/**
 * The subscribe verb takes no parameters — the subscription is node-scoped and
 * a filter member would be a second place the node's own registry scope is
 * decided. Spelled as an empty interface to match the canonical wire shape, on
 * the `desktop-bridge.ts` in-package precedent for the same rule exemption.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderAccountSubscribeRequest {}

export const ProviderAccountSubscribeRequestSchema: z.ZodType<
  ProviderAccountSubscribeRequest,
  ProviderAccountSubscribeRequest
> = z.object({}).strict();

const PROVIDER_LOGIN_OUTCOME_VALUES = ["succeeded", "failed", "cancelled"] as const;

export type ProviderLoginOutcome = (typeof PROVIDER_LOGIN_OUTCOME_VALUES)[number];
export const PROVIDER_LOGIN_OUTCOMES: readonly ProviderLoginOutcome[] =
  PROVIDER_LOGIN_OUTCOME_VALUES;

export type ProviderAccountNotification =
  /** Registered, corrected, default moved, or a stored reading rewritten by any of its writers. */
  | { kind: "account_changed"; account: ProviderAccount }
  | { kind: "account_removed"; accountId: ProviderAccountId }
  /**
   * Correlated on `attemptId`. `succeeded` is a report FROM THE PROVIDER that
   * its flow finished — it is NOT itself a reading that the account is
   * authenticated. The daemon takes an ordinary health observation next and
   * publishes the result as `account_changed`; a client that treats this
   * notification as the authentication verdict will render an account as ready
   * that a spawn would refuse.
   */
  | {
      kind: "login_completed";
      attemptId: string;
      accountId: ProviderAccountId;
      outcome: ProviderLoginOutcome;
      /**
       * Operator-facing message text. Carries NO credential material, no
       * provider error body verbatim, and no home path.
       */
      failureReason?: string | undefined;
    }
  | {
      kind: "usage_window_updated";
      accountId: ProviderAccountId;
      window: ProviderAccountUsageWindow;
    };

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
      // The outer `accountId` is the ROUTING key; `window.accountId` is part of
      // the reading. Both are carried deliberately — the list reply's
      // `usageWindows` entries carry the same member, so a live update and a
      // snapshot row key alike — and a notification whose reading names a
      // different account than its envelope is not routable in either
      // direction: a consumer keying off the outer member files the reading
      // under an account it does not describe, and one keying off the inner
      // member ignores the routing the daemon performed. Refused against
      // `window.accountId`, the half that contradicts the envelope it arrived
      // in.
      .superRefine((notification, ctx) => {
        if (notification.window.accountId !== notification.accountId) {
          ctx.addIssue({
            code: "custom",
            path: ["window", "accountId"],
            message:
              "usage_window_updated carries a reading for a different account than the notification routes to; window.accountId must equal the notification's accountId.",
          });
        }
      }),
  ]);

// --------------------------------------------------------------------------
// Transport redaction marking (I-029-11)
// --------------------------------------------------------------------------

/**
 * Wire member names a request-logging transport MUST redact before emitting a
 * record. Declared here rather than re-derived at each transport, so adding a
 * credential-accepting member and forgetting to redact it is one omission
 * instead of N.
 *
 * The census suite asserts this list has exactly one entry, that the entry is a
 * member of exactly one REQUEST shape in this module, and that no response or
 * notification shape declares a member of that name.
 */
export const PROVIDER_ACCOUNT_REDACTED_WIRE_MEMBERS: readonly string[] = ["nonInteractiveToken"];

// --------------------------------------------------------------------------
// The wire-shape registry — the census's subject set
// --------------------------------------------------------------------------
//
// Every request, response, and notification schema in this module appears here
// exactly once. The registry exists so the I-029-11 census DERIVES its subject
// set rather than hand-listing it: a hand-listed census passes forever after
// someone adds an eleventh shape, which is precisely the incremental widening
// ADR-028 names as its failure mode and this census as its detection.
//
// `direction` is what makes the count meaningful: credential material may
// appear on `request` shapes (exactly one member, on exactly one shape) and on
// NO `response` or `notification` shape.

export type ProviderAccountWireDirection = "request" | "response" | "notification";

export interface ProviderAccountWireShape {
  /** The exported interface's name, for a failure message that names the offender. */
  readonly name: string;
  readonly direction: ProviderAccountWireDirection;
  readonly schema: z.ZodType<unknown>;
}

export const PROVIDER_ACCOUNT_WIRE_SHAPES: readonly ProviderAccountWireShape[] = [
  {
    name: "ProviderAccountListRequest",
    direction: "request",
    schema: ProviderAccountListRequestSchema,
  },
  {
    name: "ProviderAccountListResponse",
    direction: "response",
    schema: ProviderAccountListResponseSchema,
  },
  {
    name: "ProviderAccountRegisterRequest",
    direction: "request",
    schema: ProviderAccountRegisterRequestSchema,
  },
  {
    name: "ProviderAccountRegisterResponse",
    direction: "response",
    schema: ProviderAccountRegisterResponseSchema,
  },
  {
    name: "ProviderAccountUpdateRequest",
    direction: "request",
    schema: ProviderAccountUpdateRequestSchema,
  },
  {
    name: "ProviderAccountUpdateResponse",
    direction: "response",
    schema: ProviderAccountUpdateResponseSchema,
  },
  {
    name: "ProviderAccountRemoveRequest",
    direction: "request",
    schema: ProviderAccountRemoveRequestSchema,
  },
  {
    name: "ProviderAccountRemoveResponse",
    direction: "response",
    schema: ProviderAccountRemoveResponseSchema,
  },
  {
    name: "ProviderAccountSetDefaultRequest",
    direction: "request",
    schema: ProviderAccountSetDefaultRequestSchema,
  },
  {
    name: "ProviderAccountSetDefaultResponse",
    direction: "response",
    schema: ProviderAccountSetDefaultResponseSchema,
  },
  {
    name: "ProviderAccountResetCredentialHomeRequest",
    direction: "request",
    schema: ProviderAccountResetCredentialHomeRequestSchema,
  },
  {
    name: "ProviderAccountResetCredentialHomeResponse",
    direction: "response",
    schema: ProviderAccountResetCredentialHomeResponseSchema,
  },
  {
    name: "ProviderAccountProbeRequest",
    direction: "request",
    schema: ProviderAccountProbeRequestSchema,
  },
  {
    name: "ProviderAccountProbeResponse",
    direction: "response",
    schema: ProviderAccountProbeResponseSchema,
  },
  {
    name: "ProviderAccountLoginRequest",
    direction: "request",
    schema: ProviderAccountLoginRequestSchema,
  },
  {
    name: "ProviderAccountLoginResponse",
    direction: "response",
    schema: ProviderAccountLoginResponseSchema,
  },
  {
    name: "ProviderAccountLoginCancelRequest",
    direction: "request",
    schema: ProviderAccountLoginCancelRequestSchema,
  },
  {
    name: "ProviderAccountLoginCancelResponse",
    direction: "response",
    schema: ProviderAccountLoginCancelResponseSchema,
  },
  {
    name: "ProviderAccountSubscribeRequest",
    direction: "request",
    schema: ProviderAccountSubscribeRequestSchema,
  },
  {
    name: "ProviderAccountNotification",
    direction: "notification",
    schema: ProviderAccountNotificationSchema,
  },
];
