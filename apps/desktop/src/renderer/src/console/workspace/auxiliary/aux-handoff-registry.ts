// Who owns a hand-off's life, and why it is not the surface that renders one.
//
// THE FAILURE. `ledger/index.ts` keys the workspace on the route's session and
// `frame/RouteSurface.tsx` keys the whole surface on the address it was mounted at, so
// leaving a session — for Settings, for another session, for the sessions list — UNMOUNTS
// the workspace. A hand-off held for that mount went with it: the shell kept the
// auxiliary windows open, because they are the shell's and nothing asked it to close
// them, and the deck came back with an empty detached set. The pane then rendered its
// body in the main window while its own auxiliary window was still rendering the same
// pane, and the return signal that window eventually sent named a pane no record
// matched — so the person had two of one surface and no way back to one of them.
//
// SO THE STATE LIVES AT THE WINDOW'S LIFETIME AND NOT AT A MOUNT'S. The other candidate
// was to close every held window when the surface goes away, and it is the wrong
// trade on the product's own terms: `Spec-023 §The surface set` gives an auxiliary
// window its own bridge instance and its own subscription to the daemon precisely so
// it is a window in its own right, and a window a person tore off should not be
// destroyed because the main window navigated to Settings. Preserving the record keeps
// the promise; closing the windows would make navigation a destructive act on a
// surface that is not even on screen.
//
// AND THE SUBJECT-SCOPED HOLDER IS NOT THAT HOME, which its own header says in as many
// words: "ONE INSTANCE PER MOUNT, held by the hook … nothing here outlives the surface
// that owns it". It is the right holder for the REGISTRY — whose subject is the bridge,
// exactly as `frame/session-lifecycle.ts` holds this window's session plumbing — and
// the wrong one for a hand-off, whose subject is a session that outlives every visit.
//
// ONE HAND-OFF PER SESSION, WHICH IS WHAT MAKES THE PANE IDS MEAN ANYTHING. A deck
// mints `pane-N` per `DeckLayout`, so two sessions' decks both hold a `pane-1`; a
// single window-wide hand-off would have shown session B a placeholder for a window
// holding session A's timeline. Keyed by session, the record a returning visit reads
// is the one its own deck wrote — the same restore that re-mints those ids from the
// same persisted arrangement.
//
// AND THE KEY ITSELF IS THE CONTRACT'S, not this module's. The shell keeps its own
// registry of held windows and had to scope it the same way for the same reason, so
// `auxiliaryWindowSessionKey` lives beside the detach request in the package all three
// processes read: two spellings of one key drift silently, and the drift is a detach
// answered with another session's window.
//
// WHAT IT DELIBERATELY DOES NOT DO IS CLOSE WINDOWS ON DISPOSAL. Disposal happens when
// the window tears down or its bridge is replaced, and in the first case the shell is
// going away with it. In the second the windows are still the shell's and still open,
// and this window's new registry does not know them — a real residual, named here
// rather than answered by destroying somebody's window on a reconnect.

import { auxiliaryWindowSessionKey } from "@ai-sidekicks/contracts";

import { AuxiliaryHandoff } from "./aux-handoff.js";
import { type ConsoleAuxiliaryWindowPort } from "./aux-window-signal-watch.js";

export interface AuxiliaryHandoffRegistryOptions {
  readonly auxiliaryWindows: ConsoleAuxiliaryWindowPort;
}

/**
 * Every hand-off this window holds, by the session each one is about.
 *
 * A CLASS WITH PRIVATE FIELDS rather than a `Map` beside a hook, on the shape
 * `store/session-store-registry.ts` already takes for the same lifetime: the map, the
 * mint rule, and the disposal are one piece of state, and holding them as free
 * bindings lets a later edit move one without the others.
 */
export class AuxiliaryHandoffRegistry {
  readonly #auxiliaryWindows: ConsoleAuxiliaryWindowPort;
  readonly #handoffsBySessionKey = new Map<string, AuxiliaryHandoff>();
  #isDisposed = false;

  public constructor(options: AuxiliaryHandoffRegistryOptions) {
    this.#auxiliaryWindows = options.auxiliaryWindows;
  }

  /** Whether this registry has been retired. Read by the holder's own closed arm. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * The hand-off for one session, minting one on the first visit.
   *
   * Idempotent by session id, which is the whole point: a second visit to a session
   * joins the record the first visit wrote rather than starting a rival one that
   * knows about none of its windows.
   *
   * AND IT TOUCHES THE WINDOW SIGNALS NOWHERE, which is a rule rather than an
   * omission. A hand-off arms them before it asks the shell for a window and closes
   * them in the same act that empties its detached set, so one handed back with panes
   * still in windows is already watching; a re-arm here would be a second owner of
   * that lifetime, and a harmful one. It is read on every render of every surface that
   * shows a pane, and a watch whose subscription the build REFUSED frees its round on
   * settling — so re-arming would re-request, re-refuse, publish the same refusal, and
   * be read again on the render that publish caused. A shell-less build would have
   * spun this window for as long as one pane was detached.
   *
   * IT MINTS DURING A RENDER, on the precedent `store/subject-scoped-resource.ts`
   * states in full: a surface's first pass already has to read the record it is a view
   * of, and a hand-off that arrived one commit later would mean a first paint drawing
   * a body that is on screen in another window. The mint is idempotent and starts
   * nothing, so a pass React discards leaves an unreferenced hand-off holding no
   * subscription rather than a resource nothing will close.
   */
  public handoffFor(sessionId: string | undefined): AuxiliaryHandoff {
    const sessionKey = auxiliaryWindowSessionKey(sessionId);
    const held = this.#handoffsBySessionKey.get(sessionKey);
    if (held !== undefined) {
      return held;
    }
    const minted = new AuxiliaryHandoff({ auxiliaryWindows: this.#auxiliaryWindows });
    this.#handoffsBySessionKey.set(sessionKey, minted);
    return minted;
  }

  /**
   * Retire every hand-off this window opened.
   *
   * The subscriptions are closed and the records dropped; the windows are left alone,
   * per this module's header. One-way, so a holder that re-commits a retired registry
   * can recognise it through {@link isDisposed} rather than plumbing a corpse.
   */
  public dispose(): void {
    this.#isDisposed = true;
    for (const handoff of this.#handoffsBySessionKey.values()) {
      handoff.stopWatchingWindowSignals();
    }
    this.#handoffsBySessionKey.clear();
  }
}
