// What a sign-in ceremony ANSWERS, and the one codec both sides of that seam read.
//
// `Spec-023 §WebAuthn Credential Flow` step 6 fixes the answer: main "resolves the
// bridge call with a `WebAuthnCeremonyOutcome` — a closed union of an authenticated
// arm carrying the participant identity claims, a fallback-required arm naming the
// probe result that produced it, and a refused arm carrying a typed reason. No arm
// carries an assertion, a PRF output, a derived key, or a handle to one."
//
// THIS MODULE IS THAT UNION, DECLARED IN `bridge/` AND NOT IN THE SIGN-IN FAMILY,
// because two things read it and they sit on opposite sides of the bridge: the
// fixture WRITES an outcome (a scenario states what this host's authenticator does)
// and the sign-in family READS one. `apps/desktop/AGENTS.md` §Shared code — "two
// sides of one seam share a module" — is the rule, and the alternative here is two
// spellings of one closed set with nothing holding them together.
//
// WHY THE OUTCOME RIDES THE RESOLUTION OF A METHOD TYPED `PublicKeyCredential`.
// The shipped bridge carries the Tier-1 three-method stub, whose
// `PublicKeyCredential` is an EMPTY interface — it asserts nothing about the value,
// by its own declaration in `packages/contracts/src/desktop-bridge.ts`. The corpus
// has already decided WHO produces the verdict and WHAT it may carry; what the
// NS-99 narrowing to `signIn()` / `register()` changes is the method name and the
// declared return type, not the producer. So reading the resolution through the
// reader below is reading the shape the corpus fixes, one method name early, and
// the narrowing is a change to `sign-in/ceremony-adapter.ts` alone.
//
// A RESOLUTION THE READER DOES NOT RECOGNISE IS `unavailable`, NEVER `authenticated`.
// The Tier-1 preload throws from every method and the fixture refuses a scenario
// that scripts no ceremony, so "this build has no ceremony" is the ordinary state
// and it renders as the _not checked_ kind of nothing. Treating an unreadable
// resolution as success would be this console asserting an identity nothing
// established — the one failure that must not be reachable from here.

import { isWireRecord, readWireString, type ConsoleRefusal } from "../../core/index.js";

/**
 * Why this host fell back to the Device Authorization Grant.
 *
 * `Spec-023 §Fallback Behavior` states the condition as a per-host PROBE result and
 * not a platform name: "the capability probe reports no usable authenticator, or the
 * authenticator that answered does not support the PRF extension". The third arm is
 * `Spec-023 §WebAuthn Platform-Authenticator Native Module`'s third detection rule —
 * a binding that will not load is a negative capability result rather than a crash.
 *
 * A closed tuple with the union derived from it, so a fourth probe result is a
 * compile error at the copy table in the sign-in family rather than a verdict that
 * renders as a blank line.
 */
export const WEB_AUTHN_PROBE_RESULTS = [
  "no-authenticator",
  "no-prf",
  "binding-unavailable",
] as const;

export type WebAuthnProbeResult = (typeof WEB_AUTHN_PROBE_RESULTS)[number];

/**
 * Why the ceremony ended without authenticating, when the host was capable.
 *
 * `cancelled` is the arm `Spec-023 §WebAuthn Credential Flow` insists is NOT a
 * capability result: "A participant who dismisses the OS dialog has answered the
 * question, and the answer is no." It is terminal — it opens no loopback and tries
 * no second provider — and the sign-in model honours that by construction.
 *
 * The other two are the relying party's verdict, which step 4 of that flow makes the
 * only thing that can turn provisional PRF bytes into a usable key: a credential the
 * server would not verify, and an options set whose origin did not match the paired
 * control-plane origin (I-023-16's refusal, raised before any binding is invoked).
 */
export const WEB_AUTHN_REFUSAL_REASONS = [
  "cancelled",
  "verification-failed",
  "origin-mismatch",
] as const;

export type WebAuthnRefusalReason = (typeof WEB_AUTHN_REFUSAL_REASONS)[number];

/**
 * Where the long-lived credential this session mints will be kept.
 *
 * `Spec-023 §Fallback Behavior`: "If the OS keystore is unavailable: refuse to
 * persist long-lived auth material; session is memory-only; surface the
 * degradation." It rides the authenticated arm because that is the moment a person
 * can still decide differently — signing in again on a repaired host, or not at all.
 * It is a statement about CUSTODY and never about the credential itself, so no arm
 * of this union carries key material of any kind.
 */
export const WEB_AUTHN_CUSTODY_STATES = ["durable", "memory-only"] as const;

export type WebAuthnCustody = (typeof WEB_AUTHN_CUSTODY_STATES)[number];

/**
 * What the browser hand-off needs, and the whole of what the renderer may hold.
 *
 * The Device Authorization Grant's user-facing half: the address to visit and the
 * code to type. Both are meant to be read aloud and typed by a person, so neither is
 * a credential — the device code that IS one stays main-side, which is why no member
 * here names it.
 */
export interface DeviceGrantHandoff {
  /** The address `native.openExternal` opens. Rendered verbatim beside the control. */
  readonly verificationUri: string;
  /** The short code a person types into that page. Rendered verbatim, in mono. */
  readonly userCode: string;
}

/**
 * What a ceremony answered. Closed; every arm renders something.
 *
 * `unavailable` is this console's arm rather than the corpus's, and it is the one a
 * build without a ceremony reaches: the Tier-1 preload throws, and a fixture whose
 * scenario scripts nothing refuses. It carries the refusal verbatim so the surface
 * renders the daemon's — or the fixture's — own sentence rather than a paraphrase.
 */
export type WebAuthnCeremonyOutcome =
  | { readonly kind: "authenticated"; readonly custody: WebAuthnCustody }
  | {
      readonly kind: "fallback-required";
      readonly probeResult: WebAuthnProbeResult;
      readonly handoff: DeviceGrantHandoff;
    }
  | { readonly kind: "refused"; readonly reason: WebAuthnRefusalReason }
  | { readonly kind: "unavailable"; readonly refusal: ConsoleRefusal };

/**
 * The arms a PRODUCER can send — everything but this console's own `unavailable`.
 *
 * `unavailable` is a reading of a build that has no ceremony (the Tier-1 preload
 * throws; a fixture whose scenario scripts none refuses), so nothing across the
 * bridge ever composes one. Excluding it here is what makes that structural: a
 * scenario cannot script it, the encoder cannot build it, and the only module that
 * can produce one is the adapter that decided the ceremony was not there.
 *
 * `Exclude` over the union rather than a second declaration, so an arm added above
 * is producible by default and excluded only by a deliberate edit to this line.
 */
export type ProducedCeremonyOutcome = Exclude<
  WebAuthnCeremonyOutcome,
  { readonly kind: "unavailable" }
>;

/**
 * What a scenario states about the host this window's ceremonies run on.
 *
 * `assertions` IS A SEQUENCE AND NOT ONE VALUE, because the sign-in flow puts the
 * SAME bridge operation twice and means two different things by it. The shipped stub
 * has no method for "wait for the loopback callback main is holding" — the fallback's
 * settlement arrives as a second assertion — so a single scripted answer would send a
 * person who pressed _Open the browser_ straight back to the hand-off they were
 * already looking at, and the device-grant path could never be exercised to its
 * finish. The last entry answers every call past its length, so a one-entry script is
 * exactly the old behaviour and a scenario states only as many steps as it has.
 *
 * `registration` is separate rather than a third assertion because it is a different
 * OPERATION on the same host, and a scenario that scripted one sequence for both
 * would make enrolment consume the sign-in's next answer.
 */
export interface ScriptedSignInCeremony {
  readonly assertions: readonly [ProducedCeremonyOutcome, ...ProducedCeremonyOutcome[]];
  /** Absent means this host refuses enrolment the way an unstated ceremony refuses. */
  readonly registration?: ProducedCeremonyOutcome;
}

/**
 * The property a ceremony resolution carries its verdict on.
 *
 * Exported because the fixture writes it and this module reads it, and a second
 * spelling of one key is the drift the shared-module rule exists to prevent.
 */
export const CEREMONY_OUTCOME_MEMBER = "ceremonyOutcome";

/**
 * Read a ceremony resolution as an outcome, or answer `undefined`.
 *
 * A READER RATHER THAN A TYPE PREDICATE, on `src/shared/wire-errors.ts`' rule: the
 * value arrives across a bridge nobody validated, so the reader hands back what it
 * has already read and leaves the caller no second access to be tempted into.
 *
 * Total over the union's discriminants and fail-closed everywhere else: an arm this
 * build does not recognise, a member of the wrong type, a missing member — every one
 * of them answers `undefined`, and the adapter renders that as _not checked_. The
 * `authenticated` arm is deliberately the strictest: it is the only arm that would
 * put a person in front of a signed-in console, so a resolution that merely LOOKS
 * authenticated without a custody state it recognises is not read as one.
 */
export function readCeremonyOutcome(value: unknown): WebAuthnCeremonyOutcome | undefined {
  if (!isWireRecord(value)) {
    return undefined;
  }
  const candidate = value[CEREMONY_OUTCOME_MEMBER];
  if (!isWireRecord(candidate)) {
    return undefined;
  }
  switch (readWireString(candidate["kind"])) {
    case "authenticated":
      return readAuthenticated(candidate);
    case "fallback-required":
      return readFallbackRequired(candidate);
    case "refused":
      return readRefused(candidate);
    default:
      return undefined;
  }
}

function readAuthenticated(
  candidate: Record<string, unknown>,
): WebAuthnCeremonyOutcome | undefined {
  const custody = WEB_AUTHN_CUSTODY_STATES.find((state) => state === candidate["custody"]);
  return custody === undefined ? undefined : { kind: "authenticated", custody };
}

function readFallbackRequired(
  candidate: Record<string, unknown>,
): WebAuthnCeremonyOutcome | undefined {
  const probeResult = WEB_AUTHN_PROBE_RESULTS.find((result) => result === candidate["probeResult"]);
  const handoff = isWireRecord(candidate["handoff"]) ? candidate["handoff"] : undefined;
  const verificationUri = readWireString(handoff?.["verificationUri"]);
  const userCode = readWireString(handoff?.["userCode"]);
  if (probeResult === undefined || verificationUri === undefined || userCode === undefined) {
    return undefined;
  }
  return { kind: "fallback-required", probeResult, handoff: { verificationUri, userCode } };
}

function readRefused(candidate: Record<string, unknown>): WebAuthnCeremonyOutcome | undefined {
  const reason = WEB_AUTHN_REFUSAL_REASONS.find((member) => member === candidate["reason"]);
  return reason === undefined ? undefined : { kind: "refused", reason };
}
