// The progress half of a provider-session import, as a reading.
//
// The import is two calls and they answer different kinds of thing. `begin` is a write
// that mints a subject and settles once. `subscribe` is a stream over that subject, and a
// stream has a state no settlement expresses: open and has said something, open and has
// said nothing yet, or closed because the producer finished. So the two are held apart.
//
// Nothing is computed from the frames: the turn count and the state are the producer's
// own words, rendered verbatim.

/** One progress report from a running import, in the producer's own words. */
export interface ImportProgressFrame {
  readonly importId: string;
  readonly turnsSeen: number;
  readonly state: string;
}

/** An open progress subscription: the frames, and the way to let go of it. */
export interface ImportProgressStream {
  readonly events: AsyncIterable<ImportProgressFrame>;
  readonly close: () => void;
}

/**
 * The call that subscribes to one import's progress.
 */
export type ImportProgressSubscribeCall = (request: {
  readonly importId: string;
}) => Promise<ImportProgressStream>;

/** Where one import's progress subscription has got to. */
export type ImportProgressReading =
  | { readonly status: "unsubscribed" }
  | { readonly status: "open"; readonly newest: ImportProgressFrame | undefined }
  | { readonly status: "closed"; readonly newest: ImportProgressFrame | undefined };

/**
 * Whether the import an id names is still being read.
 *
 * BESIDE THE UNION RATHER THAN IN THE PANEL, because it is a claim about which arms
 * of a closed set mean "still going" — a consumer spelling that out itself is a
 * second reading of this vocabulary, and the `switch` here fails to compile the day
 * a new arm lands rather than quietly answering `false` for it.
 *
 * `unsubscribed` counts as underway ONLY once an id exists, and that is the whole
 * reason the id is a parameter: before a begin settles the reading is `unsubscribed`
 * because nothing was asked, and after it settles the reading is STILL `unsubscribed`
 * for the frame between the commit and the effect that opens the stream. Reading the
 * arm alone would leave the control enabled for that frame — the same overlap the
 * open stream would leave, one frame earlier.
 */
export function isImportUnderway(
  importId: string | undefined,
  progress: ImportProgressReading,
): boolean {
  if (importId === undefined) {
    return false;
  }
  switch (progress.status) {
    case "unsubscribed":
    case "open":
      return true;
    case "closed":
      return false;
  }
}
