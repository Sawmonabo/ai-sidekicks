import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import type { DiagramOutcome, DrawnDiagram } from "./drawing.js";
import { watchDiagramPalette, type DiagramPalette } from "./palette.js";
import { diagramPictures } from "./pictures.js";

/** What a diagram block shows: its source while it waits, its picture, or why it has none. */
export type DiagramDrawing =
  | { readonly status: "waiting" }
  | { readonly status: "drawn"; readonly picture: DrawnDiagram }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The drawing of one diagram in the screen's palette. A block still streaming waits. A settled
 * block shows a kept picture on its first render, at its final size; otherwise it asks for one to
 * be drawn in its window's idle time. When the theme or the text size changes, the picture it
 * showed stays until the one for the new palette lands, so nothing under it moves twice.
 */
export function useDrawnDiagram(source: string, isSettled: boolean): DiagramDrawing {
  const ownerWindow = useOwnerWindow();
  const palette = useDiagramPalette(ownerWindow);
  const [heard, setHeard] = useState<HeardOutcome | undefined>(undefined);
  const shownPicture = useRef<DrawnDiagram | undefined>(undefined);

  const outcome = useMemo(
    () =>
      isSettled
        ? (diagramPictures.read(source, palette) ??
          (heard?.source === source && heard.palette === palette ? heard.outcome : undefined))
        : undefined,
    [isSettled, source, palette, heard],
  );
  const isMissing = isSettled && outcome === undefined;

  useEffect(() => {
    if (!isMissing) {
      return undefined;
    }
    return diagramPictures.request(source, palette, ownerWindow, (drawn) => {
      setHeard({ source, palette, outcome: drawn });
    });
  }, [isMissing, source, palette, ownerWindow]);

  // Written after commit and read only while a redraw is missing, so it never costs a render.
  useEffect(() => {
    if (outcome?.kind === "drawn") {
      shownPicture.current = outcome;
    }
  }, [outcome]);

  if (outcome === undefined) {
    return isSettled && shownPicture.current !== undefined
      ? { status: "drawn", picture: shownPicture.current }
      : { status: "waiting" };
  }
  return outcome.kind === "drawn"
    ? { status: "drawn", picture: outcome }
    : { status: "failed", reason: outcome.reason };
}

/** An outcome this block heard, with what it asked for, so one for an older ask is ignored. */
interface HeardOutcome {
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly outcome: DiagramOutcome;
}

/** The palette this window's diagrams are drawn with, re-read when theme or text size changes. */
function useDiagramPalette(ownerWindow: Window): DiagramPalette {
  const watch = watchDiagramPalette(ownerWindow);
  const subscribe = useCallback((listener: () => void) => watch.subscribe(listener), [watch]);
  const read = useCallback(() => watch.read(), [watch]);
  return useSyncExternalStore(subscribe, read);
}
