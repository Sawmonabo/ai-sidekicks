// Drains one provider's import stream for as long as its holder is mounted.
//
// The subscribe call is the caller's. A rejected call, or a stream that rejects part-way,
// settles the reading as `failed` with the service's own words. The stream is opened once per
// provider and closed on the way out, since one left open after unmount is a producer with no
// reader; a message arriving after that installs nowhere because the disposal flag is read
// before every publish.

import { useEffect, useState } from "react";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";

import type { ProviderImportProgress } from "@ai-sidekicks/contracts/provider/import";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";
import type {
  ImportProgressReading,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "./progress.js";

const UNSUBSCRIBED: ImportProgressReading = { status: "unsubscribed" };

/** The subsystem a failed import stream names as its author. */
const IMPORT_PROGRESS_ORIGIN = "provider-import-progress";

/**
 * Drain one provider's import stream for as long as its holder is mounted.
 * `provider` is `undefined` until an import is put. That is the `unsubscribed` arm, not an
 * empty `open` one: nothing has been asked, and "no progress yet" would answer a question
 * nobody put.
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

    const drain = async (): Promise<void> => {
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
    };
    drain().catch((error: unknown) => {
      if (!isDisposed) {
        setReading({ status: "failed", refusal: coerceToRefusal(error, IMPORT_PROGRESS_ORIGIN) });
      }
    });

    return () => {
      isDisposed = true;
      openStream?.close();
      openStream = undefined;
    };
  }, [subscribe, provider]);

  return reading;
}
