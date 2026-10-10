// A pane another screen asked a session's pane layout to open. The layout is born inside the
// session screen, so a screen elsewhere (a workflow run's page) cannot reach it: it leaves the
// request here, moves the window to the session, and the session's layout takes it once its saved
// arrangement is restored. One request is held per window; a newer one replaces it, since only the
// last press says where the person meant to go.

import type { Unsubscribe } from "#shared/preload-api.js";

import { Emitter } from "#renderer/lib/emitter.js";
import type { BlockPaneAddress } from "#renderer/routing/panes/address.js";

/** One held request: the session whose layout should open the pane, and the pane's address. */
export interface PaneOpenRequest {
  readonly sessionId: string;
  readonly address: BlockPaneAddress;
}

/** The window's one held pane-open request. One instance per window store. */
export class PaneOpenRequests {
  readonly #arrivals = new Emitter<PaneOpenRequest>("pane open request");
  #held: PaneOpenRequest | undefined;

  /** Hold a request, replacing any request still held, and tell the layouts it arrived. */
  public request(request: PaneOpenRequest): void {
    this.#held = request;
    this.#arrivals.emit(request);
  }

  /**
   * The held address when it is for this session, which is then no longer held; `undefined` when
   * nothing is held for it. A request for another session stays for that session's layout.
   */
  public take(sessionId: string): BlockPaneAddress | undefined {
    const held = this.#held;
    if (held?.sessionId !== sessionId) {
      return undefined;
    }
    this.#held = undefined;
    return held.address;
  }

  /** Called with each request as it is held. */
  public onArrival(listener: (request: PaneOpenRequest) => void): Unsubscribe {
    return this.#arrivals.subscribe(listener);
  }
}
