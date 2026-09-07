// The captures this window took, and the cards they justify.
//
// `Spec-023 §Console Design (Meridian)` 12.2 gives the pane a capture control and
// 12.6 says what becomes of its bytes: they enter the one ingest pipeline and land as
// an artifact. The shelf beside this module renders one row per produced object, and
// a row is only a CARD where every prop on it came from somewhere real.
//
// THIS IS THAT SOMEWHERE. A capture taken here answers with the artifact it became,
// the media type the pipeline stored, and the byte length it stored — so the card's
// name, kind, size, and ingest state are all the act's own answer. Nothing is
// inferred, and an object this window did not produce gets no card at all.
//
// THE REGISTER IS PER PANE AND BOUNDED. It is held against the pane the captures were
// taken in, so a deck slot handed a different pane does not carry one pane's captures
// onto another's shelf, and it keeps the newest few rather than growing for the life
// of the window. Dropping the tail costs a row nobody scrolled to; it costs no
// artifact, because the object is in the session's log and on the timeline either way.

import { useCallback, useMemo } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { CAPTURED_OBJECT_ROW_CAP } from "../../core/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import type { BrowserPaneActs } from "../pane/act-sequence.js";
import { producedObjectArtifactId, type ProducedObjectCard } from "./produced-objects.js";

/** What a capture that never answered says, where the rejection carries no code. */
const CAPTURE_CALL_FALLBACK = {
  code: "capture-call-failed",
  detail:
    "The page could not be captured from this window, because the call into the browser never answered.",
} as const;

export interface CapturedObjects {
  /** Cards for the captures this pane took, keyed by the artifact each became. */
  readonly cardsByArtifactId: ReadonlyMap<string, ProducedObjectCard>;
  /** Capture the visible page into the session's artifacts. */
  readonly capture: () => void;
}

/**
 * Take captures in this pane, and remember the ones that landed.
 *
 * The act goes through the pane's own act sequence, so a capture refusal renders in
 * the same one place every other chrome refusal does and an older act cannot overwrite
 * a newer one's answer.
 */
export function useCapturedObjects(
  bridge: ConsoleBridge,
  paneId: string,
  acts: BrowserPaneActs,
): CapturedObjects {
  const { value: cards, publish } = useSubjectScopedState<readonly ProducedObjectCard[]>(
    bridge,
    paneId,
    () => [],
  );
  const { run } = acts;

  const capture = useCallback((): void => {
    run(async () => {
      const outcome = await bridge.growth.browserCapture({ paneId });
      if (outcome.status === "unavailable") {
        return outcome;
      }
      const { artifactId, mediaType, byteLength } = outcome.value;
      publish((held) =>
        [
          {
            kind: "capture" as const,
            props: {
              captureName: artifactId,
              // The human control captures what is on screen. The clip and full-page
              // scopes belong to the page tool that offers a choice; this one does not.
              scope: "viewport" as const,
              mediaType,
              ingest: { status: "stored" as const, artifactId, byteLength },
            },
          },
          ...held.filter((card) => producedObjectArtifactId(card) !== artifactId),
        ].slice(0, CAPTURED_OBJECT_ROW_CAP),
      );
      return undefined;
    }, CAPTURE_CALL_FALLBACK);
  }, [bridge, paneId, publish, run]);

  const cardsByArtifactId = useMemo((): ReadonlyMap<string, ProducedObjectCard> => {
    const byId = new Map<string, ProducedObjectCard>();
    for (const card of cards) {
      byId.set(producedObjectArtifactId(card), card);
    }
    return byId;
  }, [cards]);

  return { cardsByArtifactId, capture };
}
