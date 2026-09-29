// Drains one import's progress subscription for as long as the panel is mounted.
//
// The subscribe call is the caller's, taken as an argument. A rejected call, or a stream
// that rejects part-way, is not caught here: it propagates. The stream is opened once per
// import and closed on the way out: a subscription left open after the panel unmounts is a
// producer with no reader. A frame arriving after that installs nowhere, because the
// disposal flag is read before every publish.

import { useEffect, useState } from "react";

import type {
  ImportProgressFrame,
  ImportProgressReading,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "./import-progress.js";

const UNSUBSCRIBED: ImportProgressReading = { status: "unsubscribed" };

/**
 * Drain one import's progress stream for as long as the panel is mounted.
 *
 * `importId` is `undefined` until the begin call settles, and that absence is the
 * `unsubscribed` arm rather than an empty `open` one: nothing has been asked, and a
 * panel rendering "no progress yet" for a question nobody put is the conflation the
 * console's five-kinds-of-nothing rule exists to prevent.
 */
export function useImportProgress(
  subscribe: ImportProgressSubscribeCall,
  importId: string | undefined,
): ImportProgressReading {
  const [reading, setReading] = useState<ImportProgressReading>(UNSUBSCRIBED);

  useEffect(() => {
    if (importId === undefined) {
      setReading(UNSUBSCRIBED);
      return;
    }
    let isDisposed = false;
    let openStream: ImportProgressStream | undefined;
    setReading({ status: "open", newest: undefined });

    void (async () => {
      const stream = await subscribe({ importId });
      if (isDisposed) {
        stream.close();
        return;
      }
      openStream = stream;
      let newest: ImportProgressFrame | undefined;
      for await (const frame of stream.events) {
        if (isDisposed) {
          return;
        }
        newest = frame;
        setReading({ status: "open", newest: frame });
      }
      if (!isDisposed) {
        setReading({ status: "closed", newest });
      }
    })();

    return () => {
      isDisposed = true;
      openStream?.close();
      openStream = undefined;
    };
  }, [subscribe, importId]);

  return reading;
}
