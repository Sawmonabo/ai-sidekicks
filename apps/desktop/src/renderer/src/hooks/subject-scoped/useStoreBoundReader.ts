// Holds one section's reader: built through the subject-scoped seam and never in a render
// body, started once it commits, rebuilt when the store it reads against is replaced, and
// subscribed through `useSyncExternalStore` so a publish is one transition.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import {
  CONTROLLER_DISPOSAL,
  type DisposableController,
} from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { type SubjectKey } from "#renderer/lib/subject-scoped/subject-scoped-holder.js";
import { useLatestRef } from "../useLatestRef.js";
import { useSubjectScopedResource } from "./useSubjectScopedResource.js";

/** What the hook needs from a reader: its reading, its start, and the store it reads against. */
export interface StoreBoundReader<TStore, TReading = unknown> extends DisposableController {
  /** What the section renders. Read through `useSyncExternalStore`, never reached into. */
  readonly snapshot: TReading;
  subscribe(sink: (reading: TReading) => void): Unsubscribe;
  /** Whether this reader's reads are taken against `store`. */
  isReadingFor(store: TStore): boolean;
  /** Read once and keep listening. */
  start(): void;
}

/** What the hook hands back: the reader to act through, and what to render. */
export interface StoreBoundReaderBinding<TReader extends StoreBoundReader<unknown>> {
  readonly reader: TReader;
  readonly reading: TReader["snapshot"];
}

/**
 * Hold one reader per `(subject, key)` and start it once it commits.
 *
 * The store is not part of the key: the seam cannot see a store replaced under the same key
 * (a projection rebuilt across a reconnect), so the reader is asked, and its replacement is
 * published through the seam, which closes the old one. Strict mode's re-run setup on a
 * closed reader is the seam's `isClosed`, and re-deriving it here would dispose that reader
 * twice. A new subject mints a new reader, so a caller holds its subject steady for as long
 * as the section should keep its reading.
 */
export function useStoreBoundReader<TStore, TReader extends StoreBoundReader<TStore>>(
  subject: object,
  key: SubjectKey,
  store: TStore,
  open: () => TReader,
): StoreBoundReaderBinding<TReader> {
  const { value: reader, settle } = useSubjectScopedResource(
    subject,
    key,
    open,
    CONTROLLER_DISPOSAL,
  );
  // Call sites pass a fresh closure every render; a listed one would re-run the effect on
  // unrelated renders.
  const latestOpen = useLatestRef(open);
  useEffect(() => {
    if (!reader.isReadingFor(store)) {
      settle()(latestOpen.current());
      return;
    }
    reader.start();
  }, [reader, settle, store, latestOpen]);
  const subscribe = useCallback(
    (onReadingChange: () => void) => reader.subscribe(onReadingChange),
    [reader],
  );
  const read = useCallback((): TReader["snapshot"] => reader.snapshot, [reader]);
  const reading = useSyncExternalStore(subscribe, read, read);
  return { reader, reading };
}
