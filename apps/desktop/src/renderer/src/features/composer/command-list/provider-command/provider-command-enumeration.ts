// The one enumeration this composer holds, read by the command list: one live reading keyed on
// the addressed agent and bridge, never persisted or cached across sessions. The read runs when
// the command list opens, so a person who never types a slash costs no provider round trip.

import { ReadScope } from "@renderer/lib/reads/read-scope.js";
import { settleEnumeration, type ProviderCommandReadState } from "./read.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** Which binding an enumeration was read under. A change discards before it re-reads. */
export interface ProviderCommandReadKey {
  readonly bridge: PlatformBridge;
  readonly sessionId: string;
  readonly agentId: string;
}

/**
 * Whether two keys name one binding. The bridge is compared by identity: two bridges holding the
 * same session are two wires with different catalogs, so a replaced bridge must re-read.
 */
function isSameReadKey(held: ProviderCommandReadKey, candidate: ProviderCommandReadKey): boolean {
  return (
    held.bridge === candidate.bridge &&
    held.sessionId === candidate.sessionId &&
    held.agentId === candidate.agentId
  );
}

/** Nobody has been asked: the composer addresses no agent, or the command list is closed. */
const NOT_CHECKED: ProviderCommandReadState = { phase: "not-checked" };

/**
 * One composer's live enumeration. A class rather than hook state, because two components read it
 * and only one may drive it; `snapshot` and `subscribe` fit `useSyncExternalStore`, so observers
 * re-render on change and never on a poll.
 */
export class ProviderCommandEnumeration {
  #state: ProviderCommandReadState = NOT_CHECKED;
  #openKey: ProviderCommandReadKey | undefined = undefined;
  // The read line of the open key: replaced on open at a new key, abandoned on close, so an old
  // read is both superseded and stopped.
  #readLine: ReadScope | undefined = undefined;
  readonly #listeners = new Set<() => void>();

  /** The reading as it stands. Stable between changes. */
  public snapshot = (): ProviderCommandReadState => this.#state;

  /** Watch the reading. */
  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Read the addressed agent's commands and skills, or keep the reading in hand when the key has
   * not moved. A key change discards before it re-reads and the interim state is `not-loaded`, so
   * a command enumerated under one binding is never offered under another.
   */
  public open(key: ProviderCommandReadKey): void {
    if (this.#openKey !== undefined && isSameReadKey(this.#openKey, key)) {
      return;
    }
    this.#openKey = key;
    // The previous address's line is over, not superseded: a new pairing gets a new line.
    this.#endReadLine();
    const readLine = new ReadScope();
    this.#readLine = readLine;
    const round = readLine.openRound();
    this.#publish({ phase: "not-loaded" });
    void settleEnumeration(key.bridge, key.sessionId, key.agentId, round.signal).then((settled) => {
      // `settle` drops a reply from a superseded or abandoned occupancy. It guards on the round,
      // not the key: a key can be re-entered after a close, and an old reply would pass a value
      // check.
      round.settle(() => {
        this.#publish(settled);
      });
    });
  }

  /** End the reading's lifetime. The command list closed, or no agent is addressed. */
  public close(): void {
    if (this.#openKey === undefined) {
      return;
    }
    this.#openKey = undefined;
    // Closing ends an outstanding read, not only its settlement, so the reply is not awaited and
    // parsed for a list that is gone.
    this.#endReadLine();
    this.#publish(NOT_CHECKED);
  }

  /** Abandon the held line and hold none, so the next `open` mints a fresh scope. */
  #endReadLine(): void {
    this.#readLine?.abandon();
    this.#readLine = undefined;
  }

  #publish(state: ProviderCommandReadState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
