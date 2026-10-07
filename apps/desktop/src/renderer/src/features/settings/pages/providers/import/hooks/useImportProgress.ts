// Drains one provider's import stream for as long as its holder is mounted.
//
// The stream opens on mount, because its first message is the provider's last outcome, so the row
// reads the same after a reload. A rejected call, or a stream that rejects part-way, settles the
// reading as `failed` with the service's own words, and `reopen` asks again. The stream is closed
// on the way out, since one left open after unmount is a producer with no reader; a message
// arriving after that installs nowhere because the disposal flag is read before every publish.

import { useEffect, useState } from "react";

import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";

import type { ProviderImportProgress } from "@ai-sidekicks/contracts/provider/import";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type {
  ImportProgressReading,
  ImportProgressStream,
  ImportProgressSubscribeCall,
} from "../progress.js";

/** One provider's import stream as read so far, and the act that opens it again. */
export interface ImportProgress {
  readonly reading: ImportProgressReading;
  /** Open the stream again after it failed or closed. */
  readonly reopen: () => void;
}

const NOTHING_SAID: ImportProgressReading = {
  status: "open",
  newest: undefined,
  replayed: undefined,
};

/** The subsystem a failed import stream names as its author. */
const IMPORT_PROGRESS_ORIGIN = "provider-import-progress";

/** Drain one provider's import stream for as long as its holder is mounted. */
export function useImportProgress(
  subscribe: ImportProgressSubscribeCall,
  provider: ProviderName,
): ImportProgress {
  const [reading, setReading] = useState<ImportProgressReading>(NOTHING_SAID);
  const [openingOrdinal, setOpeningOrdinal] = useState(0);

  useEffect(() => {
    let isDisposed = false;
    let openStream: ImportProgressStream | undefined;
    setReading(NOTHING_SAID);

    const drain = async (): Promise<void> => {
      const stream = await subscribe({ provider });
      if (isDisposed) {
        stream.close();
        return;
      }
      openStream = stream;
      let newest: ProviderImportProgress | undefined;
      let replayed: ProviderImportProgress | undefined;
      for await (const message of stream.events) {
        if (isDisposed) {
          return;
        }
        newest = message;
        replayed ??= message;
        setReading({ status: "open", newest: message, replayed });
      }
      if (!isDisposed) {
        setReading({ status: "closed", newest, replayed });
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
  }, [subscribe, provider, openingOrdinal]);

  return {
    reading,
    reopen: () => {
      setOpeningOrdinal((held) => held + 1);
    },
  };
}
