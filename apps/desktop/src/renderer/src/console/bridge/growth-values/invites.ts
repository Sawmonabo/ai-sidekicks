// The invite plane's values: what a pending confirmation carries, and how an
// attempt on one ends.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
//
// THE PENDING FEED CARRIES THREE STATES AND NOT ONE. `Plan-023 §Phase 2 — IPC Bridge
// Registry And Per-Surface Handlers` task T-023r-2-5 pins the pending side as a
// discriminated union keyed on `status`: a preview that SUCCEEDED (`ready`), one the
// control plane REFUSED (`refused`, terminal, no reference to confirm), and one that
// could not be put at all (`unavailable`, retryable, carrying an opaque
// non-confirmable attempt handle). Typing the feed as the ready arm alone would leave
// an expired or revoked link and an unreachable control plane with nowhere to arrive,
// so the window would show nothing at all for the two cases a person most needs told
// about.
//
// THE REFERENCE IS THE WHOLE POINT OF THIS SHAPE. `Plan-023 §Invariants` I-023-5 and
// I-023-10 confine the raw invite token to the main process and hand the renderer an
// opaque, single-use, TTL-bounded reference instead. So there is no `token` member
// here and there is nowhere for one to arrive: a renderer holding this value cannot
// compose an acceptance out of it, which is what makes the confinement a property of
// the type rather than a rule someone has to remember.
//
// EVERY DISPLAY FACT IS INDEPENDENTLY ABSENT-ABLE, because the registered
// `InvitePreviewResponse` declares `sessionName` and `inviterDisplayName` as
// `string | null` and V1 has no session-naming producer at all. `null` is carried
// rather than the member being optional: the preview ANSWERED and the fact was empty,
// which is a different reading from a preview that was never put — and the
// confirmation renders those two differently.

import type { JoinMode } from "@ai-sidekicks/contracts";

/**
 * One invitation waiting on this participant's confirmation.
 *
 * Composed by the main process from the anonymous non-consuming `invite.preview`
 * mutation, which `Plan-023 §Invariants` I-023-9 makes the only control-plane call
 * the deep-link path issues before confirmation. A preview that REFUSED mints no
 * reference at all, so a value of this shape existing is itself the statement that a
 * preview succeeded — the other two states the feed carries are
 * {@link GrowthPendingInviteRefused} and {@link GrowthPendingInviteUnavailable}, and
 * neither has anywhere for a reference to arrive.
 */
export interface GrowthPendingInvite {
  /**
   * The opaque, single-use, TTL-bounded handle main resolves the confined token by.
   *
   * Never rendered and never parsed. It addresses one pending confirmation for as
   * long as main holds it, and the second attempt on one finds nothing.
   */
  readonly reference: string;
  /** Wire-verbatim. The identity the confirmation falls back to naming. */
  readonly sessionId: string;
  readonly joinMode: JoinMode;
  /** ISO 8601, wire-verbatim. */
  readonly expiresAt: string;
  /** `null` where the preview answered and the session has no name. */
  readonly sessionName: string | null;
  /** `null` where the preview answered and the inviter has no display name. */
  readonly inviterDisplayName: string | null;
}

/**
 * The handle a preview that could not be put is retried by.
 *
 * A DISTINCT BRAND FROM THE REFERENCE, which is the whole reason it exists. Two
 * protocol URLs can be outstanding at once, so a retry has to say which deep link it
 * means — and `Plan-023 §Phase 2 — IPC Bridge Registry And Per-Surface Handlers` task
 * T-023r-2-5 makes it a separate brand accepted by no other operation, so a handle
 * that can re-drive a preview can never confirm one. Nothing mints one in this renderer: it arrives on
 * the wire and travels back out on the retry, unread.
 */
export type GrowthInviteAttempt = string & { readonly __brand: "GrowthInviteAttempt" };

/**
 * A preview that succeeded, as it arrives on the pending feed.
 *
 * The ready arm's own facts are {@link GrowthPendingInvite}, which is what a surface
 * renders and what the reference-bearing acts are dispatched on; this adds only the
 * discriminant the feed is keyed by.
 */
export interface GrowthPendingInviteReady extends GrowthPendingInvite {
  readonly status: "ready";
}

/**
 * A preview the control plane answered with a typed refusal.
 *
 * NO REFERENCE, and the shape is where that is enforced. A refused preview mints
 * nothing main can resolve, so there is no member a surface could confirm on — which
 * is what makes "the renderer cannot manufacture a reference" a property of the type
 * rather than a rule a component has to keep.
 */
export interface GrowthPendingInviteRefused {
  readonly status: "refused";
  /** The registered invite refusal code, wire-verbatim. */
  readonly code: string;
  /** The sentence the wire sent, verbatim. Never a substitute for the code. */
  readonly detail: string;
}

/**
 * A preview that could not be put at all.
 *
 * NEITHER A VALID INVITATION NOR A REFUSAL, which is why it is its own arm: an
 * unreachable or erroring control plane has said nothing about this invitation, so
 * rendering it as a refusal would report a decision nobody made. It carries the
 * attempt handle and no reference, so the one act it admits is the retry.
 */
export interface GrowthPendingInviteUnavailable {
  readonly status: "unavailable";
  /** Always true. The arm exists because the state can be tried again. */
  readonly retryable: true;
  /** Which outstanding deep link failed. Never rendered and never parsed. */
  readonly attempt: GrowthInviteAttempt;
}

/**
 * The two arms that mint no reference.
 *
 * Named once rather than spelled as a pair at each reader: both are prompts about a
 * deep link that produced nothing to confirm, and every surface that handles one
 * handles the other.
 */
export type GrowthPendingInvitePreviewFailure =
  | GrowthPendingInviteRefused
  | GrowthPendingInviteUnavailable;

/** Every state one deep link's preview can reach, as the pending feed carries it. */
export type GrowthPendingInviteState = GrowthPendingInviteReady | GrowthPendingInvitePreviewFailure;

/**
 * The four ways an attempt on a pending invitation ends.
 *
 * FOUR ARMS AND NOT TWO. The shipped acceptance component settles `resolved` or
 * `rejected`, which reads an authentication detour and a daemon refusal as the same
 * event — and they are not: one is a step the person can complete and the other is a
 * door that is closed. Both authentication arms are therefore their own members, so
 * a surface cannot render them with a refusal's copy without deleting a branch.
 *
 * Every arm carries the `reference` it is about, because a window may hold one
 * pending confirmation and receive the outcome of the one it dismissed a moment ago.
 * A surface matches on it rather than assuming the feed speaks only of what is on
 * screen.
 */
export type GrowthInviteOutcome =
  | {
      readonly kind: "joined";
      readonly reference: string;
      /** The session joined, wire-verbatim — the id the frame navigates to. */
      readonly sessionId: string;
      /** The membership the acceptance activated, wire-verbatim. */
      readonly membershipId: string;
      /** The role that membership holds, wire-verbatim. */
      readonly role: string;
    }
  | {
      readonly kind: "authentication-required";
      readonly reference: string;
    }
  | {
      readonly kind: "authentication-failed";
      readonly reference: string;
      /** What the authentication attempt reported, verbatim. Never composed here. */
      readonly detail: string;
    }
  | {
      readonly kind: "refused";
      readonly reference: string;
      /** The registered invite refusal code, wire-verbatim. */
      readonly code: string;
      /** The sentence the wire sent, verbatim. Never a substitute for the code. */
      readonly detail: string;
    };
