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
//
// AND A STREAM HAS FOUR WAYS TO FINISH, NOT THREE. The call can refuse, the producer
// can finish, the panel can unmount — and the iterator can REJECT part-way, which a
// torn-down subscription and an undecodable frame both do. That fourth one has no
// state of its own: it is the `refused` arm, reached from the middle of a reading
// rather than from its start, because a delivery that stopped is a delivery that
// failed and a line left sitting on its last frame says the opposite.

import { useEffect, useState } from "react";

import { normalizeWireRejection, type ConsoleRefusal } from "../../core/index.js";
import {
  settleGrowthRead,
  type GrowthImportProgress,
  type GrowthPort,
} from "../../bridge/index.js";

/** The subsystem name a refusal this module composes itself carries. */
const IMPORT_PROGRESS_REFUSAL_ORIGIN = "provider-import-progress";

/**
 * What a broken progress subscription refuses under, where the failure carries no
 * code of its own.
 *
 * A fallback and not a mapping: `normalizeWireRejection` is the console's one
 * rejection reader, so a refusal the bridge raised travels through naming its own
 * author and a typed wire envelope keeps its own code — flattening those into this
 * sentence would throw away the only actionable half. This pair is reached only where
 * neither applies.
 *
 * The sentence deliberately does not say the import stopped. What this window knows is
 * that it is no longer being told; whether the daemon is still reading the transcript
 * is a different question, and claiming an answer to it would be the console inventing
 * one.
 */
const PROGRESS_STREAM_FAILURE_FALLBACK = {
  code: "import-progress-subscription-failed",
  detail:
    "This window is no longer being told how the import is going. Whether it is still running is not something this window can see; starting another import opens a new subscription.",
};

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
 *
 * THE CALL AND THE ITERATOR FAIL THE SAME WAY AND SETTLE THE SAME WAY. One `try`
 * covers both, because a subscription that never opened and one that broke leave the
 * panel in the same place — with no reading — and the only honest thing to render for
 * either is the refusal saying so. Left uncaught, the second was an unhandled
 * rejection in the renderer, a line frozen on its last frame reading as though
 * delivery were still coming, and a stream handle nobody closed.
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
    let openStream: { close(): void } | undefined;
    /** Close the acquired stream at most once, from whichever path reaches it first. */
    const closeStream = (): void => {
      const acquired = openStream;
      openStream = undefined;
      acquired?.close();
    };
    setReading({ status: "open", newest: undefined });

    void (async () => {
      try {
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
        openStream = outcome.value;
        let newest: GrowthImportProgress | undefined;
        for await (const frame of outcome.value.events) {
          if (isDisposed) {
            return;
          }
          newest = frame;
          setReading({ status: "open", newest: frame });
        }
        if (!isDisposed) {
          setReading({ status: "closed", newest });
        }
      } catch (failure) {
        // The stream goes first and unconditionally: a producer that rejected part-way
        // is still a subscription somebody has to end, and a failure arriving after the
        // panel has gone publishes nothing — there is no surface left to read it.
        closeStream();
        if (!isDisposed) {
          setReading({
            status: "refused",
            refusal: normalizeWireRejection(
              IMPORT_PROGRESS_REFUSAL_ORIGIN,
              failure,
              PROGRESS_STREAM_FAILURE_FALLBACK,
            ),
          });
        }
      }
    })();

    return () => {
      isDisposed = true;
      closeStream();
    };
  }, [growth, importId]);

  return reading;
}
