// The ONE module in this console that names the `webAuthn` bridge namespace.
//
// WHY IT IS ONE MODULE. `Spec-023 §WebAuthn Credential Flow` step 1 fixes the
// ceremony's eventual shape — `webAuthn.signIn()`, taking no argument, answering a
// `WebAuthnCeremonyOutcome` — and the bridge this build ships carries the Tier-1
// three-method stub instead (`createCredential`, `getAssertion`, `deriveKeyMaterial`,
// declared in `packages/contracts/src/desktop-bridge.ts`). Narrowing that surface is
// T-023r-2-5's work, not this console's, so every line that knows which methods exist
// today lives here and the narrowing is a change to this file alone: the model above
// it, the two cards, and the overlay name only {@link SignInCeremony}.
//
// WHAT THE RENDERER SUPPLIES, WHICH IS NOTHING (I-023-16). Main fetches the
// server-issued options — `rpId`, origin, challenge, transaction id — over its own
// authenticated channel and validates them against the control-plane origin pinned
// when this install was paired. So no challenge, no relying-party identifier, and no
// PRF salt crosses the bridge, and the empty object below is the whole of the
// renderer's contribution to a ceremony. It is a literal rather than a named
// constant precisely so a reader meets the emptiness at the call.
//
// WHY `deriveKeyMaterial` IS NAMED HERE AND NEVER CALLED. It is the third method on
// the shipped stub and it is main's, both by step 5 of that flow — the wrapping key
// "lives in its own address space and is never exposed to the renderer" — and by
// I-023-16, which leaves the renderer with no salt to derive against. Calling it
// from here would be this console choosing a PRF input, which is exactly the
// trust-boundary inversion the invariant was minted to close. This module's own
// suite holds the family to that by reading every shipped source in the directory.
//
// WHY THE DEVICE-GRANT WAIT IS A SECOND CALL AND NOT A POLL. `Spec-023 §Fallback
// Behavior` puts the loopback capture in the main process — "surfaced as a
// `localhost:<port>/callback` browser capture" — and the blueprint's own wire table
// records that no wire method exists for it and none is needed. So the renderer opens
// the browser and then awaits the ceremony once more: main is already holding this
// window's grant, and it answers when the callback lands. One awaited call, no timer,
// no repeat read — which is the console's no-interval-polling rule met rather than
// worked around.

import type { ConsoleBridge } from "../bridge/index.js";
import { readCeremonyOutcome, type WebAuthnCeremonyOutcome } from "../bridge/index.js";
import { consoleRefusalFrom } from "../seats/index.js";

/** Names this ceremony in a refusal the rejected call did not name itself. */
const SIGN_IN_ORIGIN = "sign-in";

/**
 * The code a refusal carries when a ceremony answered something unreadable.
 *
 * Its own code rather than the generic read failure, because the two are different
 * facts and a person acting on them does different things: a rejected call has a
 * reason somebody wrote down, and a resolution this build cannot read is a bridge
 * whose ceremony surface is not the one this console compiles against.
 */
const CEREMONY_UNREADABLE = "ceremony-unreadable";

/**
 * The ceremony, as the sign-in surface sees it.
 *
 * A class rather than three loose functions: it holds the bridge for the life of one
 * window's sign-in and it is the seam a test substitutes, which the package standard
 * puts in a class rather than in a render body.
 *
 * Every method is TOTAL. None of them rejects, and none of them throws: a ceremony
 * that failed answers the `unavailable` or `refused` arm carrying what it was told,
 * because a sign-in card whose promise rejects has nothing to render and a person
 * looking at it learns nothing at all.
 */
export class SignInCeremony {
  readonly #bridge: ConsoleBridge;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
  }

  /**
   * Run the sign-in ceremony for whatever authenticator this host probed.
   *
   * `getAssertion` is the shipped stub's authentication method and the one
   * `signIn()` replaces. The renderer passes no options, per I-023-16.
   */
  public async signIn(): Promise<WebAuthnCeremonyOutcome> {
    return this.#run(async () => this.#bridge.sidekicks.webAuthn.getAssertion({}));
  }

  /**
   * Enrol a credential for a participant this install is already signed in as.
   *
   * `createCredential` is the shipped stub's registration method and the one
   * `register()` replaces. `Spec-023 §WebAuthn Credential Flow` makes the enrolment
   * path the authenticated one, which is why the surface offers it only from a
   * signed-in state and never as a way in.
   */
  public async register(): Promise<WebAuthnCeremonyOutcome> {
    return this.#run(async () => this.#bridge.sidekicks.webAuthn.createCredential({}));
  }

  /**
   * Wait for the Device Authorization Grant callback main is holding.
   *
   * The same ceremony method: main knows this window is mid-grant, so asking again
   * is asking for the settlement rather than starting a second flow. It is a named
   * operation here — rather than the caller writing `signIn()` twice — because the
   * two mean different things to every reader above, and because the narrowing gives
   * the wait a method of its own without moving anything but this body.
   */
  public async awaitDeviceGrant(): Promise<WebAuthnCeremonyOutcome> {
    return this.#run(async () => this.#bridge.sidekicks.webAuthn.getAssertion({}));
  }

  /**
   * Run one ceremony call and read its answer, whichever way it settles.
   *
   * FAIL-CLOSED IN BOTH DIRECTIONS. A resolution the reader does not recognise is
   * `unavailable` and never `authenticated` — the Tier-1 preload throws and a fixture
   * with no scripted host refuses, so "this build has no ceremony" is the ordinary
   * case, and reading an unrecognised value as success would put a person in front of
   * a signed-in console on the strength of nothing. A rejection is `unavailable` too,
   * carrying its refusal verbatim: no `auth.*` sign-in code is registered anywhere in
   * the corpus, so there is no typed refusal vocabulary to map onto and the honest
   * rendering is the message its producer wrote.
   */
  async #run(call: () => Promise<unknown>): Promise<WebAuthnCeremonyOutcome> {
    let resolution: unknown;
    try {
      resolution = await call();
    } catch (rejection: unknown) {
      return {
        kind: "unavailable",
        refusal: consoleRefusalFrom(rejection, SIGN_IN_ORIGIN, CEREMONY_UNREADABLE),
      };
    }
    return (
      readCeremonyOutcome(resolution) ?? {
        kind: "unavailable",
        refusal: {
          origin: SIGN_IN_ORIGIN,
          code: CEREMONY_UNREADABLE,
          detail:
            "The ceremony answered something this build cannot read as an outcome, so nothing was read from it.",
        },
      }
    );
  }
}
