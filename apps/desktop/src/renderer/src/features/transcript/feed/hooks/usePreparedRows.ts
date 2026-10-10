import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";

import { watchDiagramPalette } from "#renderer/components/Markdown/diagram/palette.js";
import { DiagramPicturesContext } from "#renderer/components/Markdown/diagram/pictures.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { type RowRevealContextValue } from "../../reveal/components/RowRevealProvider.js";
import { type OffListTables } from "../../rows/markdown/table-window/off-list.js";
import { type TranscriptRowPreparer, type TranscriptRowSources } from "../../rows/renderer.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { PreparedRowGate, type PreparedRows } from "../prepared-rows.js";

/** One pass's rows, and the gate's answers a landing waits on. */
export interface PreparedRowsBinding
  extends
    PreparedRows,
    Pick<PreparedRowGate, "isPrepared" | "isHeldOut" | "holdsRowAfter" | "subscribeToWork"> {}

/**
 * Hold each drawn row out of the window until it draws whole, and keep the listed rows ready to
 * scroll to, reading a row's live text through the reveal channel its body reads. One gate per
 * session, disposed with the feed, so a held row of one log never waits in another's. A held row's
 * long tables are measured in `offListTables`.
 */
export function usePreparedRows(
  model: TranscriptWindowModel,
  prepareRow: TranscriptRowPreparer,
  revealChannel: RowRevealContextValue,
  offListTables: OffListTables,
  sessionId: string,
): PreparedRowsBinding {
  const bridge = usePlatformBridge();
  const gate = useSubjectScopedResource(bridge, sessionId, openGate, CONTROLLER_DISPOSAL).value;
  const readiness = useSyncExternalStore(gate.subscribe, gate.readReadiness);
  const ownerWindow = useOwnerWindow();
  const diagramPictures = useContext(DiagramPicturesContext);
  const publishedTextFor = revealChannel.publishedTextFor;
  const sources = useMemo<TranscriptRowSources>(
    () => ({ publishedTextFor, ownerWindow, diagramPictures, offListTables }),
    [publishedTextFor, ownerWindow, diagramPictures, offListTables],
  );
  // Every drained frame may have settled a block in a row the virtualizer has not mounted, and a
  // new palette draws every picture again, so both refresh the rows the window lists.
  const subscribeToFrames = revealChannel.subscribe;
  useEffect(() => {
    const refresh = (): void => {
      gate.refresh();
    };
    const stopFrames = subscribeToFrames(refresh);
    const stopPalette = watchDiagramPalette(ownerWindow).subscribe(refresh);
    return () => {
      stopFrames();
      stopPalette();
    };
  }, [gate, subscribeToFrames, ownerWindow]);
  return useMemo(
    () => ({
      ...gate.filter(model, prepareRow, sources),
      isPrepared: gate.isPrepared,
      isHeldOut: gate.isHeldOut,
      holdsRowAfter: gate.holdsRowAfter,
      subscribeToWork: gate.subscribeToWork,
    }),
    // A held row becoming ready is what `readiness` reports; the pass reads it from the gate.
    [gate, model, prepareRow, sources, readiness],
  );
}

function openGate(): PreparedRowGate {
  return new PreparedRowGate();
}
