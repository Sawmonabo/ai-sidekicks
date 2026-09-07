// The progress half of a provider-session import: the subscription, drained.
//
// The import is TWO calls and they answer different kinds of thing. `begin` is a
// write that mints a subject — it settles once, and `act-settlement.ts` holds it like
// any other act. `subscribe` is a stream over that subject, and a stream has a state
// no settlement expresses: it is open and has said something, open and has said
// nothing yet, closed because it finished, or closed because it refused. So the two
// are held apart rather than folded into one four-armed value that would have to mean
// something different depending on which call it came from.
//
// THE STREAM IS OPENED ONCE PER IMPORT AND CLOSED ON THE WAY OUT. `GrowthStream`
// carries its own `close()`, and a subscription left open after the panel unmounts is
// a producer with no reader — the RAM the console's budgets are measured against, and
// on the live wire a subscription the daemon still holds. The effect's cleanup closes
// it, and a frame arriving after that installs nowhere: the disposal flag is read
// before every publish, so a generator mid-yield cannot write into an unmounted tree.
//
// NOTHING IS COMPUTED FROM THE FRAMES. The turn count and the state are the
// producer's own words, rendered verbatim; a percentage would be this console
// inventing a denominator nobody sent.

import { useEffect, useState } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import {
  settleGrowthRead,
  type GrowthImportProgress,
  type GrowthPort,
} from "../../bridge/index.js";

/** Where one import's progress subscription has got to. */
export type ImportProgressReading =
  | { readonly status: "unsubscribed" }
  | { readonly status: "open"; readonly newest: GrowthImportProgress | undefined }
  | { readonly status: "closed"; readonly newest: GrowthImportProgress | undefined }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

const UNSUBSCRIBED: ImportProgressReading = { status: "unsubscribed" };

/**
 * Whether the import an id names is still being read.
 *
 * BESIDE THE UNION RATHER THAN IN THE PANEL, because it is a claim about which arms
 * of a closed set mean "still going" — a consumer spelling that out itself is a
 * second reading of this vocabulary, and the `switch` here fails to compile the day
 * a fifth arm lands rather than quietly answering `false` for it.
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
    case "refused":
      return false;
  }
}

/**
 * Drain one import's progress stream for as long as the panel is mounted.
 *
 * `importId` is `undefined` until the begin call settles, and that absence is the
 * `unsubscribed` arm rather than an empty `open` one: nothing has been asked, and a
 * surface rendering "no progress yet" for a question nobody put is the conflation
 * `Spec-023 §Console Design (Meridian)` rule 8 exists to prevent.
 */
export function useImportProgress(
  growth: GrowthPort,
  importId: string | undefined,
): ImportProgressReading {
  const [reading, setReading] = useState<ImportProgressReading>(UNSUBSCRIBED);

  useEffect(() => {
    if (importId === undefined) {
      setReading(UNSUBSCRIBED);
      return;
    }
    let isDisposed = false;
    let openStreamClose: (() => void) | undefined;
    setReading({ status: "open", newest: undefined });

    void (async () => {
      // Through the console's one rejection reader, for the reason the panel next
      // door states: this port throws a scripted refusal verbatim, and a drain that
      // read only the fulfilment arm would leave the line reading "open, nothing yet"
      // forever while an unhandled rejection reached the window.
      const outcome = await settleGrowthRead(growth.providerSessionImportSubscribe({ importId }));
      if (isDisposed) {
        if (outcome.status === "served") {
          outcome.value.close();
        }
        return;
      }
      if (outcome.status !== "served") {
        setReading({ status: "refused", refusal: outcome });
        return;
      }
      const stream = outcome.value;
      openStreamClose = () => {
        stream.close();
      };
      let newest: GrowthImportProgress | undefined;
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
      openStreamClose?.();
    };
  }, [growth, importId]);

  return reading;
}
