// Drains one provider's import stream for as long as its holder is mounted.
//
// The subscribe call is the caller's, taken as an argument. A rejected call, or a stream
// that rejects part-way, is not caught here: it propagates. The stream is opened once per
// provider and closed on the way out: a subscription left open after its holder unmounts
// is a producer with no reader. A message arriving after that installs nowhere, because
// the disposal flag is read before every publish.

import { useEffect, useState } from "react";

import type { ProviderImportProgress, ProviderName } from "@ai-sidekicks/contracts";
import type {
  ImportProgressReading,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "./import-progress.js";

const UNSUBSCRIBED: ImportProgressReading = { status: "unsubscribed" };

/**
 * Drain one provider's import stream for as long as its holder is mounted.
 *
 * `provider` is `undefined` until an import is put, and that absence is the
 * `unsubscribed` arm rather than an empty `open` one: nothing has been asked, and a
 * panel rendering "no progress yet" for a question nobody put is the conflation the
 * console's five-kinds-of-nothing rule exists to prevent.
 */
export function useImportProgress(
  subscribe: ImportProgressSubscribeCall,
  provider: ProviderName | undefined,
): ImportProgressReading {
  const [reading, setReading] = useState<ImportProgressReading>(UNSUBSCRIBED);

  useEffect(() => {
    if (provider === undefined) {
      setReading(UNSUBSCRIBED);
      return;
    }
    let isDisposed = false;
    let openStream: ImportProgressStream | undefined;
    setReading({ status: "open", newest: undefined });

    void (async () => {
      const stream = await subscribe({ provider });
      if (isDisposed) {
        stream.close();
        return;
      }
      openStream = stream;
      let newest: ProviderImportProgress | undefined;
      for await (const message of stream.events) {
        if (isDisposed) {
          return;
        }
        newest = message;
        setReading({ status: "open", newest: message });
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
  }, [subscribe, provider]);

  return reading;
}
