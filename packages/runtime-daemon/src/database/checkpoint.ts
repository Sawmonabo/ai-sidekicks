// A WAL checkpoint the database writer runs on its connection, and what SQLite reports of it.

/** A WAL checkpoint mode the writer runs. */
export type CheckpointMode = "PASSIVE" | "TRUNCATE";

/** How a checkpoint treats a reader that holds an older snapshot of the log. */
export interface CheckpointOptions {
  /**
   * Whether a busy checkpoint waits out the connection's busy timeout for the reader before it
   * answers busy; `false` answers at once, so the writer is held for no wait. Defaults to `true`.
   */
  readonly shouldWaitForReaders?: boolean;
}

/** What a WAL checkpoint reports, in SQLite's own terms. */
export interface CheckpointResult {
  /** Whether another connection kept the checkpoint from finishing. */
  readonly isBusy: boolean;
  /** Frames in the write-ahead log. */
  readonly logFrames: number;
  /** Frames moved into the database file. */
  readonly checkpointedFrames: number;
}
