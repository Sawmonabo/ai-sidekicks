// The sign-in card's state, and the discipline that keeps one ceremony at a time.
//
// `Spec-023 §Console Design (Meridian)` gives this surface its states through the
// flow it fixes rather than through a screen: signed out; a passkey prompt in
// flight; a host that probed no usable authenticator, moving to the Device
// Authorization Grant; that grant awaiting its loopback callback; signed in; and
// signed in with the OS keystore unavailable, which `Spec-023 §Fallback Behavior`
// makes a memory-only session that must be surfaced rather than hidden.
//
// A CLASS BECAUSE THE STATE IS NOT A DERIVATION. A ceremony is in flight or it is
// not, a superseded ceremony must not publish into a card that has moved on, and a
// second press while one is running must not start a second OS dialog. Those are
// three rules about one piece of state, which the package standard puts in an
// encapsulated class rather than in a component body.
//
// SUPERSESSION IS A GENERATION AND NOT A FLAG. A window can be closed, or its bridge
// replaced, while an OS dialog is still open: the ceremony settles afterwards, into
// a flow whose card is gone. Every settlement is stamped with the generation that
// started it and dropped unless it still matches, which is the ordering rule the
// console's own subject-scoped holder uses one level up.
//
// AN ENROLMENT REVOKES NOTHING. Adding a second authenticator is an act performed
// FROM a session rather than a second way into one, so every way it can end without
// adding a passkey — a dismissed prompt, a host whose probe found nothing usable, a
// build with no ceremony at all — leaves the session it ran from exactly as it was,
// and the refusal is carried ON the signed-in arm rather than replacing it. Settling
// the generic refused arm here signed a participant out for cancelling an optional
// extra, and dismissing that refusal then walked them to the signed-out card.
//
// A CANCELLATION IS TERMINAL AND OPENS NO LOOPBACK. `Spec-023 §WebAuthn Credential
// Flow` is explicit: a participant who dismisses the OS dialog "has answered the
// question, and the answer is no", so the refused arm must not fall through to the
// Device Authorization Grant — "which would present a browser sign-in to a
// participant who just declined to sign in". Only the `fallback-required` arm opens
// it, and that arm is reached by the host having nothing that works.

import { Emitter, type Unsubscribe } from "../core/index.js";
import type {
  DeviceGrantHandoff,
  WebAuthnCeremonyOutcome,
  WebAuthnCustody,
  WebAuthnProbeResult,
  WebAuthnRefusalReason,
} from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import type { SignInCeremony } from "./ceremony-adapter.js";

/**
 * What an enrolment settled into when it added no authenticator.
 *
 * `Exclude` over the ceremony's own union rather than a second list of arms, on the
 * rule `ProducedCeremonyOutcome` follows next door: an arm added to the outcome is
 * carried here by default, and dropping one is a deliberate edit to this line. Only
 * `authenticated` is subtracted, because that is the arm that ADDS a passkey and so
 * is not a refusal at all.
 *
 * `fallback-required` is a refusal HERE and a hand-off on the way in. The Device
 * Authorization Grant is how a host with no usable authenticator signs IN; reaching
 * it from an enrolment would present a browser sign-in to somebody already signed
 * in, so the probe result is reported beside the control and no grant is opened.
 */
export type EnrolmentRefusal = Exclude<WebAuthnCeremonyOutcome, { readonly kind: "authenticated" }>;

/**
 * What the sign-in card shows. Closed; every arm renders something.
 *
 * `handing-off` and `awaiting-callback` are two states and not one, because the act
 * between them is the participant's: the first is the card holding a code and an
 * unpressed control, the second is this window waiting on main's loopback listener.
 * Collapsing them would either open a browser nobody asked for or leave a person
 * looking at a code with nothing to do next.
 */
export type SignInState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "passkey-in-flight" }
  | {
      readonly kind: "handing-off";
      readonly probeResult: WebAuthnProbeResult;
      readonly handoff: DeviceGrantHandoff;
    }
  | { readonly kind: "awaiting-callback"; readonly handoff: DeviceGrantHandoff }
  | {
      readonly kind: "signed-in";
      readonly custody: WebAuthnCustody;
      /**
       * The last enrolment started from this session, when it added no passkey.
       *
       * Present only while it is unread: dismissing it clears the member and keeps
       * the session, because an enrolment that added nothing changed nothing about
       * the authentication it was started from.
       */
      readonly enrolmentRefusal?: EnrolmentRefusal;
    }
  | { readonly kind: "refused"; readonly reason: WebAuthnRefusalReason }
  | { readonly kind: "unavailable"; readonly refusal: ConsoleRefusal };

/** Where a window starts: nothing asked, nothing claimed. */
const SIGNED_OUT: SignInState = { kind: "signed-out" };

/** The state every passkey ceremony publishes while it is unsettled. */
const PASSKEY_IN_FLIGHT: SignInState = { kind: "passkey-in-flight" };

/**
 * The sign-in ceremony as one window drives it.
 *
 * Every method that starts a ceremony is single-flight: a second press while one is
 * unsettled does nothing at all rather than opening a second OS dialog, because the
 * platform dialog is modal and a second request against the same authenticator is a
 * refusal on some hosts and a queued prompt on others — neither of which a person
 * asked for by pressing a button that already worked.
 */
export class SignInFlow {
  readonly #ceremony: SignInCeremony;
  readonly #changes = new Emitter<void>("sign-in state");
  #state: SignInState = SIGNED_OUT;
  #generation = 0;
  #inFlight = false;

  public constructor(ceremony: SignInCeremony) {
    this.#ceremony = ceremony;
  }

  public get state(): SignInState {
    return this.#state;
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Whether a ceremony is unsettled, so a control can wait rather than refuse. */
  public get isBusy(): boolean {
    return this.#inFlight;
  }

  /** Start the passkey ceremony. Does nothing while one is unsettled. */
  public async signIn(): Promise<void> {
    await this.#drive(PASSKEY_IN_FLIGHT, async () => this.#ceremony.signIn());
  }

  /**
   * Enrol another authenticator for the participant already signed in here.
   *
   * Offered only from the signed-in state, which the card enforces by not drawing
   * the control anywhere else — `Spec-023 §WebAuthn Credential Flow` makes enrolment
   * the authenticated path, and this method refusing to run from a signed-out state
   * is the same rule stated where it cannot be drawn around.
   */
  public async register(): Promise<void> {
    const session = this.#state;
    if (session.kind !== "signed-in") {
      return;
    }
    // The session is captured BEFORE the ceremony starts and settled back onto
    // afterwards, which is the whole of the rule: the pending state this publishes is
    // the same waiting card the way in shows, and without the capture there would be
    // nothing left to restore it from once the outcome landed.
    await this.#drive(
      PASSKEY_IN_FLIGHT,
      async () => this.#ceremony.register(),
      (outcome) => enrolmentSettlement(session.custody, outcome),
    );
  }

  /**
   * Wait for main's loopback capture, having handed the participant to a browser.
   *
   * Reachable only from `handing-off`, so the wait cannot be started for a grant
   * this window never obtained.
   */
  public async awaitDeviceGrant(): Promise<void> {
    const current = this.#state;
    if (current.kind !== "handing-off") {
      return;
    }
    const waiting: SignInState = { kind: "awaiting-callback", handoff: current.handoff };
    await this.#drive(waiting, async () => this.#ceremony.awaitDeviceGrant());
  }

  /**
   * Clear the refusal on screen, without asking anything.
   *
   * The refusal grammar says a refusal never hides the control that produced it; a
   * person dismissing one is asking to see that control again, not to retry, so this
   * publishes a state and calls no ceremony.
   *
   * WHERE IT PUTS THE CARD DEPENDS ON WHAT THE REFUSAL WAS ABOUT. A sign-in that was
   * refused leaves nothing behind it, so its dismissal is the signed-out card. An
   * enrolment that was refused ran FROM a session, and that session is still good —
   * so its dismissal drops the refusal alone and the card stays signed in.
   */
  public dismissRefusal(): void {
    const current = this.#state;
    if (current.kind === "signed-in") {
      if (current.enrolmentRefusal !== undefined) {
        this.#publish({ kind: "signed-in", custody: current.custody });
      }
      return;
    }
    if (current.kind === "refused" || current.kind === "unavailable") {
      this.#publish(SIGNED_OUT);
    }
  }

  /**
   * Drop this flow's claim on anything still unsettled.
   *
   * Called when the window that owns it goes away. It bumps the generation rather
   * than cancelling — the OS dialog belongs to main and this window cannot close it
   * — so whatever settles later publishes nowhere.
   */
  public supersede(): void {
    this.#generation += 1;
    this.#inFlight = false;
  }

  /**
   * Run one ceremony under the single-flight and supersession rules.
   *
   * `settle` is a parameter rather than a fixed call because the SAME outcome means
   * two different things depending on which ceremony produced it: a refusal from the
   * way in is the refused card, and a refusal from an enrolment is a note on the
   * session that is still signed in. Deriving that from the pending state instead
   * would make the mapping a guess about which leg is running.
   */
  async #drive(
    pending: SignInState,
    run: () => Promise<WebAuthnCeremonyOutcome>,
    settle: (outcome: WebAuthnCeremonyOutcome) => SignInState = stateFromOutcome,
  ): Promise<void> {
    if (this.#inFlight) {
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;
    this.#inFlight = true;
    this.#publish(pending);
    const outcome = await run();
    if (generation !== this.#generation) {
      // Superseded: a newer ceremony started, or this flow was retired. The
      // `inFlight` flag belongs to whoever bumped the generation, so it is not
      // cleared here — clearing it would release a slot this flow no longer holds.
      return;
    }
    this.#inFlight = false;
    this.#publish(settle(outcome));
  }

  #publish(next: SignInState): void {
    this.#state = next;
    this.#changes.emit();
  }
}

/**
 * The state one ENROLMENT outcome settles into, given the session it ran from.
 *
 * Only `authenticated` replaces the session, and it replaces it wholly: a passkey
 * that was added re-states where this session's credential is kept and drops any
 * earlier refusal, because the attempt that failed has now succeeded. Every other
 * arm republishes the custody it was handed with the refusal beside it, so nothing a
 * participant did to an optional extra can revoke what they are already signed in
 * with.
 */
function enrolmentSettlement(
  custody: WebAuthnCustody,
  outcome: WebAuthnCeremonyOutcome,
): SignInState {
  if (outcome.kind === "authenticated") {
    return { kind: "signed-in", custody: outcome.custody };
  }
  return { kind: "signed-in", custody, enrolmentRefusal: outcome };
}

/**
 * The state one ceremony outcome settles into.
 *
 * Total over the outcome union and exported for its own test: it is the whole of the
 * mapping this surface performs on a wire-shaped value, and a case reading the wrong
 * way here is the difference between a person being told they are signed in and
 * being told their authenticator cannot do PRF.
 */
export function stateFromOutcome(outcome: WebAuthnCeremonyOutcome): SignInState {
  switch (outcome.kind) {
    case "authenticated":
      return { kind: "signed-in", custody: outcome.custody };
    case "fallback-required":
      return {
        kind: "handing-off",
        probeResult: outcome.probeResult,
        handoff: outcome.handoff,
      };
    case "refused":
      return { kind: "refused", reason: outcome.reason };
    case "unavailable":
      return { kind: "unavailable", refusal: outcome.refusal };
  }
}
