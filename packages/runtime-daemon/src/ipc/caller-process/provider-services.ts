// The provider services the daemon holds a connection to, known by the process serving each. The
// person's own Codex service runs outside the daemon's tree, so a command an agent runs on it is
// known only as that process's descendant; a caller descending from any of them is refused as
// one the daemon started is.

import type * as net from "node:net";

import type { CallerProcessReader } from "./contract.js";

/** The processes serving the provider service connections the daemon holds now. */
export class ProviderServiceProcesses {
  readonly #reader: Pick<CallerProcessReader, "readPeerProcessId">;
  // Each serving process with the number of connections held to it.
  readonly #holds = new Map<number, number>();

  constructor(reader: Pick<CallerProcessReader, "readPeerProcessId">) {
    this.#reader = reader;
  }

  /**
   * Holds the process serving the dialed `socket` until the returned release is called, which
   * releases once however often it is called. Throws when the system cannot name the process,
   * the service having closed its end included.
   */
  holdServing(socket: net.Socket): () => void {
    const processId = this.#reader.readPeerProcessId(socket);
    if (processId === undefined) {
      throw new Error("The provider service closed its connection before its process was read");
    }
    this.#holds.set(processId, (this.#holds.get(processId) ?? 0) + 1);
    let isReleased = false;
    return () => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      // Still counted: an entry goes only when its last hold is released.
      const remaining = this.#holds.get(processId)! - 1;
      if (remaining === 0) {
        this.#holds.delete(processId);
      } else {
        this.#holds.set(processId, remaining);
      }
    };
  }

  /** Whether the process with the id serves a provider service connection the daemon holds. */
  has(processId: number): boolean {
    return this.#holds.has(processId);
  }
}
