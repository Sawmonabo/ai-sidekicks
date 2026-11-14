// What the client helper keeps for each shell on its one daemon connection, which every window
// speaks over. The daemon holds one pause state and one count of waiting writes per connection and
// shell, so the helper counts across windows: the connection is declared behind while any window
// watching the shell is behind, the daemon hearing a change only when that crosses zero, and a
// write waits here while the connection's writes to the shell fill the cap. A window that goes
// takes its marks with it, and a new connection is told every shell still behind. What the daemon
// was told is noted as an update goes and put back when the daemon refuses it.

import {
  TERMINAL_WRITES_WAITING_LIMIT,
  TERMINAL_WRITES_WAITING_PER_SHELL,
  type TerminalFlowControlUpdateRequest,
  type TerminalWriteRequest,
} from "@ai-sidekicks/contracts/terminal";

import { carriesSignalKey } from "#shared/terminal-signal-keys.js";

/**
 * A flow update the daemon is to be told: the state to send, and the act that puts back what the
 * daemon was told before it, for an update the daemon refused or never got.
 */
export interface FlowTelling {
  readonly paused: boolean;
  readonly putBack: () => void;
}

/** The connection's shells, by session and shell, shared by every asker on the connection. */
export class ConnectionShells<Asker> {
  readonly #tellDaemon: (update: TerminalFlowControlUpdateRequest, telling: FlowTelling) => void;
  readonly #shells = new Map<string, ConnectionShell<Asker>>();
  /** Counts the connections, so a put-back for one already gone changes nothing. */
  #connectionCount = 0;

  /** `tellDaemon` sends the connection's own flow update, one no asker's call carries. */
  public constructor(
    tellDaemon: (update: TerminalFlowControlUpdateRequest, telling: FlowTelling) => void,
  ) {
    this.#tellDaemon = tellDaemon;
  }

  /**
   * Note the state `asker` declares for one shell. Answers the connection's state to send when the
   * daemon was last told otherwise, or `undefined` when it already holds it.
   */
  public declareFlow(
    asker: Asker,
    update: TerminalFlowControlUpdateRequest,
  ): FlowTelling | undefined {
    const key = shellKeyOf(update);
    const shell = this.#shellFor(key, update);
    if (update.paused) {
      shell.behindAskers.add(asker);
    } else {
      shell.behindAskers.delete(asker);
    }
    const isBehind = shell.behindAskers.size > 0;
    const telling = isBehind === shell.isToldPaused ? undefined : this.#tell(key, shell, isBehind);
    this.#forgetWhenIdle(key, shell);
    return telling;
  }

  /** An asker that went: its marks drop, and a shell no one is behind on any more resumes. */
  public forgetAsker(asker: Asker): void {
    for (const [key, shell] of this.#shells) {
      if (!shell.behindAskers.delete(asker)) {
        continue;
      }
      if (shell.behindAskers.size === 0 && shell.isToldPaused) {
        this.#tellDaemon({ ...shell.subject, paused: false }, this.#tell(key, shell, false));
      }
      this.#forgetWhenIdle(key, shell);
    }
  }

  /** The connection is gone or being replaced: the next one has been told nothing. */
  public forgetConnection(): void {
    this.#connectionCount += 1;
    for (const [key, shell] of this.#shells) {
      shell.isToldPaused = false;
      this.#forgetWhenIdle(key, shell);
    }
  }

  /** Tell the connection now open every shell an asker is behind on that it has not been told. */
  public tellUntold(): void {
    for (const [key, shell] of this.#shells) {
      if (shell.behindAskers.size > 0 && !shell.isToldPaused) {
        this.#tellDaemon({ ...shell.subject, paused: true }, this.#tell(key, shell, true));
      }
    }
  }

  /**
   * Wait until the connection may send `write`, in the order writes came: while fewer than
   * `TERMINAL_WRITES_WAITING_PER_SHELL` of its writes to the shell wait, or fewer than
   * `TERMINAL_WRITES_WAITING_LIMIT` for a write carrying a signal key and every write before it.
   * Resolves with the release, called once the daemon answered or the write was not sent.
   */
  public takeWriteRoom(write: TerminalWriteRequest): Promise<() => void> {
    const key = shellKeyOf(write);
    const shell = this.#shellFor(key, write);
    const isSignal = write.kind === "keys" && carriesSignalKey(write.data);
    if (isSignal) {
      // The writes typed before the signal go ahead of it, so they take its room too.
      for (const held of shell.heldWrites) {
        held.cap = TERMINAL_WRITES_WAITING_LIMIT;
      }
    }
    const room = Promise.withResolvers<() => void>();
    shell.heldWrites.push({
      cap: isSignal ? TERMINAL_WRITES_WAITING_LIMIT : TERMINAL_WRITES_WAITING_PER_SHELL,
      admit: room.resolve,
    });
    this.#admitWrites(key, shell);
    return room.promise;
  }

  #admitWrites(key: string, shell: ConnectionShell<Asker>): void {
    for (
      let next = shell.heldWrites[0];
      next !== undefined && shell.writesWaitingCount < next.cap;
      next = shell.heldWrites[0]
    ) {
      shell.heldWrites.shift();
      shell.writesWaitingCount += 1;
      let isReleased = false;
      next.admit(() => {
        if (isReleased) {
          return;
        }
        isReleased = true;
        shell.writesWaitingCount -= 1;
        this.#admitWrites(key, shell);
        this.#forgetWhenIdle(key, shell);
      });
    }
  }

  // Notes `paused` as told; its put-back holds only while the connection is the same one and
  // nothing told the shell anything since.
  #tell(key: string, shell: ConnectionShell<Asker>, paused: boolean): FlowTelling {
    shell.isToldPaused = paused;
    shell.toldRevision += 1;
    const revision = shell.toldRevision;
    const connection = this.#connectionCount;
    return {
      paused,
      putBack: () => {
        const held = this.#shells.get(key);
        if (
          connection !== this.#connectionCount ||
          shell.toldRevision !== revision ||
          (held !== undefined && held !== shell)
        ) {
          return;
        }
        shell.isToldPaused = !paused;
        shell.toldRevision += 1;
        this.#shells.set(key, shell);
        this.#forgetWhenIdle(key, shell);
      },
    };
  }

  #shellFor(key: string, subject: ShellSubject): ConnectionShell<Asker> {
    const held = this.#shells.get(key);
    if (held !== undefined) {
      return held;
    }
    const created: ConnectionShell<Asker> = {
      subject: { sessionId: subject.sessionId, terminalId: subject.terminalId },
      behindAskers: new Set(),
      isToldPaused: false,
      toldRevision: 0,
      writesWaitingCount: 0,
      heldWrites: [],
    };
    this.#shells.set(key, created);
    return created;
  }

  #forgetWhenIdle(key: string, shell: ConnectionShell<Asker>): void {
    if (
      shell.behindAskers.size === 0 &&
      !shell.isToldPaused &&
      shell.writesWaitingCount === 0 &&
      shell.heldWrites.length === 0
    ) {
      this.#shells.delete(key);
    }
  }
}

/** The session and shell a flow update or a write names. */
type ShellSubject = Pick<TerminalFlowControlUpdateRequest, "sessionId" | "terminalId">;

/** One shell on the connection, kept while an asker is behind on it or a write waits. */
interface ConnectionShell<Asker> {
  readonly subject: ShellSubject;
  readonly behindAskers: Set<Asker>;
  /** Whether the daemon was told, over the connection now held or being opened, it is behind. */
  isToldPaused: boolean;
  /** Counts each telling and put-back, so a stale put-back changes nothing. */
  toldRevision: number;
  /** The connection's writes to the shell sent and not yet answered. */
  writesWaitingCount: number;
  /** Writes waiting for room, oldest first, each with the count it may be sent below. */
  readonly heldWrites: { cap: number; readonly admit: (release: () => void) => void }[];
}

function shellKeyOf(subject: ShellSubject): string {
  return `${subject.sessionId} ${subject.terminalId}`;
}
