// A WAL checkpoint the database writer runs on its connection, and what SQLite reports of it.

/** A WAL checkpoint mode the writer runs. */
export type CheckpointMode = "PASSIVE" | "TRUNCATE";

/** What a WAL checkpoint reports, in SQLite's own terms. */
export interface CheckpointResult {
  /** Whether another connection kept the checkpoint from finishing. */
  readonly isBusy: boolean;
  /** Frames in the write-ahead log. */
  readonly logFrames: number;
  /** Frames moved into the database file. */
  readonly checkpointedFrames: number;
}
