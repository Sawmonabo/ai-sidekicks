// One definition, handed from the settings page to the session's attach form.
//
// TWO SURFACES, ONE ACT. The saved-sidekick registry lives in settings and the attach
// form lives in a session, which is the shape the design asks for — a definition is
// node-local and a session is not — and it leaves "attach from here" with nowhere to
// put its subject. This handoff is that place: the row offers a definition, the attach
// form claims it, and neither surface holds a handle on the other.
//
// RENDERER-LOCAL AND NOTHING ELSE. No wire is sent, nothing is persisted, and no
// daemon is told. What an offer says is which definition the next attach in this
// window should open on, which is a fact about a person's intent between two presses
// and belongs nowhere durable.
//
// AT MOST ONE OFFER PER WINDOW, WHICH IS WHY THIS HOLDS AND DOES NOT QUEUE. A second
// press replaces the first: a person who changed their mind meant the second
// definition, and a queue would attach the one they abandoned first. Nothing
// accumulates and nothing needs sweeping.
//
// KEYED ON THE BRIDGE, so it is per WINDOW — the same key `bridge/quotas/` uses and
// for the same reason: an auxiliary window holds its own bridge and therefore its own
// handoff, and a closed window takes its offer with it rather than leaving one behind
// in a map nothing prunes.
//
// THE SESSION IS PART OF THE OFFER AND IS CHECKED AT THE CLAIM. An offer made while
// this window was working in one session is not honoured by a form scoped to another:
// attaching into a session nobody named would be this console choosing where an agent
// lands.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { Emitter, type Unsubscribe } from "../../../core/index.js";

/** A definition offered to one session's attach form, and the session it is for. */
export interface AttachHandoffOffer {
  /** The session the offering surface was working in. Checked at the claim. */
  readonly sessionId: string;
  /** The registry's own identity for the definition. Never its mutable name. */
  readonly definitionId: string;
  /**
   * What the offering surface called it, so the offer reads as a sentence.
   *
   * A LABEL CARRIED FOR DISPLAY AND NEVER A KEY. It is the operator's own word at the
   * moment of the press; the attach form resolves the definition through
   * {@link AttachHandoffOffer.definitionId} against its own read and never through
   * this.
   */
  readonly definitionName: string;
}

/**
 * One window's standing offer.
 *
 * A CLASS RATHER THAN A MODULE-LEVEL VALUE, per this package's structure rule: the
 * offer and its watchers are state, and state with a lifetime lives behind private
 * fields where a reader can see who may change it.
 */
export class AttachHandoff {
  #offer: AttachHandoffOffer | undefined;
  // The console's own emitter rather than a set of callbacks kept here: one
  // implementation per job, and this one already names what it is emitting about in
  // the diagnostics a leaked subscription produces.
  readonly #changes = new Emitter<void>("attach handoff");

  /** The offer currently standing, or `undefined` where none is. */
  public get standingOffer(): AttachHandoffOffer | undefined {
    return this.#offer;
  }

  /** Offer a definition to a session's attach form, replacing any standing offer. */
  public offer(offer: AttachHandoffOffer): void {
    this.#offer = offer;
    this.#changes.emit();
  }

  /** Take the offer back. The press that made it is the press that undoes it. */
  public withdraw(): void {
    if (this.#offer === undefined) {
      return;
    }
    this.#offer = undefined;
    this.#changes.emit();
  }

  /**
   * Take the standing offer if it was made for this session, clearing it.
   *
   * ONE-SHOT, which is what keeps a handoff from being a setting. An offer honoured
   * once is spent: a person who opens the attach form again a week later is opening
   * it, not re-running a press they made before lunch.
   */
  public claim(sessionId: string): AttachHandoffOffer | undefined {
    const held = this.#offer;
    if (held === undefined || held.sessionId !== sessionId) {
      return undefined;
    }
    this.#offer = undefined;
    this.#changes.emit();
    return held;
  }

  /** Watch this handoff. The returned function stops watching. */
  public watch(watcher: () => void): Unsubscribe {
    return this.#changes.subscribe(watcher);
  }
}

/**
 * The handoffs, one per bridge.
 *
 * A `WeakMap` so a closed window's handoff is collectable with the bridge it belongs
 * to, and a class rather than a bare map so the module holds no mutable binding of its
 * own — the shape `bridge/quotas/provider-quota-feed.ts` established for exactly this
 * per-window question.
 */
class WindowAttachHandoffs {
  readonly #byBridge = new WeakMap<ConsoleBridge, AttachHandoff>();

  public forBridge(bridge: ConsoleBridge): AttachHandoff {
    const held = this.#byBridge.get(bridge);
    if (held !== undefined) {
      return held;
    }
    const created = new AttachHandoff();
    this.#byBridge.set(bridge, created);
    return created;
  }
}

const windowAttachHandoffs = new WindowAttachHandoffs();

/**
 * This window's attach handoff.
 *
 * Resolved through the table on every call rather than held by a caller, so two
 * surfaces asking for "this window's handoff" cannot end up holding two.
 */
export function attachHandoffFor(bridge: ConsoleBridge): AttachHandoff {
  return windowAttachHandoffs.forBridge(bridge);
}
