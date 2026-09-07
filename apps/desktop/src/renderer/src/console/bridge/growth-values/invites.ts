// The invite plane's values: what a pending confirmation carries, and how an
// attempt on one ends.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys; this file is the domain's own text.
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
 * preview succeeded — there is no refused arm here, and a refusal reaches the surface
 * on the outcome feed instead.
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
