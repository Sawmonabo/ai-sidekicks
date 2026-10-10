import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefCallback,
  type RefObject,
} from "react";

import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { watchDiagramPalette, type DiagramPalette } from "./palette.js";
import { DiagramPicturesContext, type DiagramPictures } from "./pictures.js";
import type { DiagramOutcome, DrawnDiagram } from "./worker/messages.js";

/** What a diagram block shows: its source while it waits, its picture, or why it has none. */
export type DiagramDrawing =
  | { readonly status: "waiting" }
  | { readonly status: "drawn"; readonly picture: DrawnDiagram }
  | { readonly status: "failed"; readonly reason: string };

/**
 * A block's drawing, the ref that shows its picture in the block's image, and the picture a copy
 * of it paints, drawn when the copy is asked for.
 */
export interface DrawnDiagramView {
  readonly drawing: DiagramDrawing;
  /** Shows the drawn picture in the image it is attached to, for as long as it stays attached. */
  readonly pictureRef: RefCallback<HTMLImageElement>;
  /** Draws the copy's picture; rejects with the reason when it cannot be drawn. */
  readonly drawCopyPicture: () => Promise<DrawnDiagram>;
}

/**
 * The drawing of one diagram in the screen's palette. A block still streaming waits. A settled
 * block shows a kept picture on its first render, at its final size; otherwise it asks the
 * diagram worker for one, placed in the queue by how far `frame` is from its window's reading
 * position. When the theme or the text size changes, the picture it showed stays until the one
 * for the new palette lands, so nothing under it moves twice.
 */
export function useDrawnDiagram(
  source: string,
  isSettled: boolean,
  frame: RefObject<HTMLElement | null>,
): DrawnDiagramView {
  const ownerWindow = useOwnerWindow();
  const pictures = useDiagramPictures();
  const palette = useDiagramPalette(ownerWindow);
  const [heard, setHeard] = useState<HeardOutcome | undefined>(undefined);
  const shownPicture = useRef<DrawnDiagram | undefined>(undefined);

  const outcome = useMemo(
    () =>
      isSettled
        ? (pictures.read(source, palette) ??
          (heard?.source === source && heard.palette === palette ? heard.outcome : undefined))
        : undefined,
    [isSettled, pictures, source, palette, heard],
  );
  const isMissing = isSettled && outcome === undefined;

  useEffect(() => {
    if (!isMissing) {
      return undefined;
    }
    return pictures.request(
      source,
      palette,
      () => readingDistanceOf(frame.current),
      (drawn) => {
        setHeard({ source, palette, outcome: drawn });
      },
    );
  }, [isMissing, pictures, source, palette, frame]);

  // Written after commit and read only while a redraw is missing, so it never costs a render.
  useEffect(() => {
    if (outcome?.kind === "drawn") {
      shownPicture.current = outcome;
    }
  }, [outcome]);

  const drawCopyPicture = useCallback(async (): Promise<DrawnDiagram> => {
    const copied = await pictures.drawCopy(source, palette);
    if (copied.kind === "failed") {
      throw new Error(copied.reason);
    }
    return copied;
  }, [pictures, source, palette]);

  const drawing = drawingOf(outcome, isSettled, shownPicture.current);
  const picture = drawing.status === "drawn" ? drawing.picture : undefined;
  const pictureRef = useCallback(
    (image: HTMLImageElement | null) => {
      if (image === null || picture === undefined) {
        return undefined;
      }
      const showing = pictures.showPicture(picture);
      image.src = showing.url;
      return showing.release;
    },
    [pictures, picture],
  );

  return { drawing, pictureRef, drawCopyPicture };
}

/** An outcome this block heard, with what it asked for, so one for an older ask is ignored. */
interface HeardOutcome {
  readonly source: string;
  readonly palette: DiagramPalette;
  readonly outcome: DiagramOutcome;
}

function drawingOf(
  outcome: DiagramOutcome | undefined,
  isSettled: boolean,
  shownPicture: DrawnDiagram | undefined,
): DiagramDrawing {
  if (outcome === undefined) {
    return isSettled && shownPicture !== undefined
      ? { status: "drawn", picture: shownPicture }
      : { status: "waiting" };
  }
  return outcome.kind === "drawn"
    ? { status: "drawn", picture: outcome }
    : { status: "failed", reason: outcome.reason };
}

/**
 * How far `element` is from the middle of its window's view, in CSS pixels: none while it spans
 * the middle, and as far as a block can be while it is not on the page.
 */
function readingDistanceOf(element: HTMLElement | null): number {
  const view = element?.ownerDocument.defaultView;
  if (element === null || view === null || view === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const readingLine = view.innerHeight / 2;
  const { top, bottom } = element.getBoundingClientRect();
  return Math.max(0, top - readingLine, readingLine - bottom);
}

/** The app's diagram pictures. Throws outside the app, which provides one for every window. */
function useDiagramPictures(): DiagramPictures {
  const pictures = useContext(DiagramPicturesContext);
  if (pictures === undefined) {
    throw new Error("A diagram block is drawn only inside the app's diagram pictures.");
  }
  return pictures;
}

/** The palette this window's diagrams are drawn with, re-read when theme or text size changes. */
function useDiagramPalette(ownerWindow: Window): DiagramPalette {
  const watch = watchDiagramPalette(ownerWindow);
  const subscribe = useCallback((listener: () => void) => watch.subscribe(listener), [watch]);
  const read = useCallback(() => watch.read(), [watch]);
  return useSyncExternalStore(subscribe, read);
}
