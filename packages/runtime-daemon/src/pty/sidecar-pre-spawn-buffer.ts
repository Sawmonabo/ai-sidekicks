import type { ExitCodeNotification } from "./pty-host-protocol.js";
// Events the Rust PTY sidecar delivers for a session id the host does not know yet, and the ids the
// host has closed. The sidecar can deliver a `DataFrame` or `ExitCodeNotification` ahead of its
// `SpawnResponse` (unbiased `select!` in `merge_to_writer`); they are held and replayed. The caps
// bound memory if events arrive for an id no response resolves.

const MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION = 64;

const MAX_PRE_SPAWN_BUFFERED_SESSIONS = 64;

/**
 * Cap on remembered closed session ids, oldest evicted first, so a late exit or data frame for a
 * closed id is dropped instead of buffered.
 */
const MAX_CLOSED_SESSION_IDS = 10_000;

/** What one session buffered before its `SpawnResponse`; either half may be absent. */
export interface PreSpawnSessionEvents {
  readonly dataFrames: Uint8Array[] | undefined;
  readonly exit: ExitCodeNotification | undefined;
}

/**
 * The bounded pre-spawn event buffers and the closed-session-id memory of one
 * `RustSidecarPtyHost`. Cleared together when the sidecar goes away, since a respawned sidecar
 * restarts its ids at `s-0`.
 */
export class SidecarPreSpawnBuffer {
  /**
   * `DataFrame` chunks for a session whose `SpawnResponse` has not arrived, replayed by
   * `replayPreSpawnEvents`. Cleared on child teardown: the sidecar's session counter restarts on
   * respawn, so old ids would replay against a new session.
   */
  private readonly pendingDataFrames: Map<string, Uint8Array[]> = new Map();

  /**
   * The `ExitCodeNotification` (at most one per session) awaiting its `SpawnResponse`; replayed and
   * cleared like `pendingDataFrames`.
   */
  private readonly pendingExits: Map<string, ExitCodeNotification> = new Map();

  /**
   * Ids removed by `close()`: a late exit or data frame for one is dropped, so `onExit` never fires
   * after `close()` resolves. Cleared on child teardown because the counter restarts on respawn and
   * a stale entry would suppress a new session that mints the same id (`s-0`).
   */
  private readonly closedSessionIds: Set<string> = new Set();

  /** Whether `close()` removed this session id since the sidecar last started. */
  public isClosed(sessionId: string): boolean {
    return this.closedSessionIds.has(sessionId);
  }

  /**
   * Buffers a data frame that arrived before its SpawnResponse, bounded by
   * `MAX_PRE_SPAWN_BUFFERED_SESSIONS` sessions and `MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION` chunks
   * each; frames over either cap are logged and dropped.
   */
  public bufferPreSpawnData(sessionId: string, bytes: Uint8Array): void {
    const existing: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    if (existing === undefined) {
      if (this.pendingDataFrames.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS) {
        console.warn(
          `RustSidecarPtyHost: pre-spawn buffer at capacity ` +
            `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
            `dropping DataFrame for session_id ${sessionId}.`,
        );
        return;
      }
      this.pendingDataFrames.set(sessionId, [bytes]);
      return;
    }
    if (existing.length >= MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION) {
      console.warn(
        `RustSidecarPtyHost: pre-spawn DataFrame buffer for session_id ` +
          `${sessionId} at capacity ` +
          `(${MAX_PRE_SPAWN_DATA_CHUNKS_PER_SESSION} chunks); ` +
          `dropping further chunks until SpawnResponse arrives.`,
      );
      return;
    }
    existing.push(bytes);
  }

  /**
   * Stores the pre-spawn `ExitCodeNotification`; the sidecar sends one per session, so a duplicate
   * is dropped with a warn. Bounded by `MAX_PRE_SPAWN_BUFFERED_SESSIONS`, like
   * `bufferPreSpawnData`.
   */
  public bufferPreSpawnExit(notification: ExitCodeNotification): void {
    if (this.pendingExits.has(notification.session_id)) {
      console.warn(
        `RustSidecarPtyHost: duplicate pre-spawn ExitCodeNotification ` +
          `for session_id ${notification.session_id} (exit_code=` +
          `${notification.exit_code}); dropping (sidecar contract is ` +
          `exactly-once-per-session).`,
      );
      return;
    }
    if (
      !this.pendingDataFrames.has(notification.session_id) &&
      this.pendingExits.size >= MAX_PRE_SPAWN_BUFFERED_SESSIONS
    ) {
      console.warn(
        `RustSidecarPtyHost: pre-spawn exit buffer at capacity ` +
          `(${MAX_PRE_SPAWN_BUFFERED_SESSIONS} stale sessions); ` +
          `dropping ExitCodeNotification for session_id ` +
          `${notification.session_id}.`,
      );
      return;
    }
    this.pendingExits.set(notification.session_id, notification);
  }

  /** Removes and returns what `sessionId` buffered before its `SpawnResponse`. */
  public takePreSpawnEvents(sessionId: string): PreSpawnSessionEvents {
    const dataFrames: Uint8Array[] | undefined = this.pendingDataFrames.get(sessionId);
    const exit: ExitCodeNotification | undefined = this.pendingExits.get(sessionId);
    this.pendingDataFrames.delete(sessionId);
    this.pendingExits.delete(sessionId);
    return { dataFrames, exit };
  }

  /**
   * Remembers a closed session id, evicting the oldest beyond `MAX_CLOSED_SESSION_IDS`. An evicted
   * id falls back to pre-spawn buffering, harmless because ids are not reused within one lifetime.
   */
  public recordClosedSessionId(sessionId: string): void {
    if (this.closedSessionIds.has(sessionId)) {
      // Already recorded; re-adding would not refresh a Set's insertion order.
      return;
    }
    if (this.closedSessionIds.size >= MAX_CLOSED_SESSION_IDS) {
      const oldest: string | undefined = this.closedSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.closedSessionIds.delete(oldest);
      }
    }
    this.closedSessionIds.add(sessionId);
  }

  /**
   * Clears the pre-spawn buffers and closed-id memory when the sidecar goes away. A respawned
   * sidecar restarts its ids at `s-0`, so stale entries would replay into or suppress a new
   * session.
   */
  public clearPreSpawnState(): void {
    this.pendingDataFrames.clear();
    this.pendingExits.clear();
    this.closedSessionIds.clear();
  }
}
