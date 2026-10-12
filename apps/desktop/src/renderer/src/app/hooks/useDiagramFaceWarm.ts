// The faces diagrams label in, warmed in idle time after the first frame for the palette of each
// open window, and again when a window's theme or text size changes it, so a diagram does not pay
// for loading them. The console document is never shown and no appearance reaches its root, so
// its palette is never one a diagram is drawn in; only the open windows are watched, each while it
// is open.

import { useEffect } from "react";

import { watchDiagramPalette } from "#renderer/components/Markdown/diagram/palette.js";
import { type DiagramPictures } from "#renderer/components/Markdown/diagram/pictures.js";
import { type OpenWindows } from "#renderer/services/window/open-windows.js";

/** Warm the diagram label faces of every open window's palette, now and on each change. */
export function useDiagramFaceWarm(
  diagramPictures: Pick<DiagramPictures, "warmDefaultFaces">,
  openWindows: OpenWindows,
): void {
  useEffect(() => {
    const stopsByWindow = new Map<Window, () => void>();
    const watchOpenWindows = (): void => {
      const openViews = new Set(openWindows.list().map((openWindow) => openWindow.window));
      for (const [view, stop] of stopsByWindow) {
        if (!openViews.has(view)) {
          stop();
          stopsByWindow.delete(view);
        }
      }
      for (const view of openViews) {
        if (stopsByWindow.has(view)) {
          continue;
        }
        const paletteWatch = watchDiagramPalette(view);
        diagramPictures.warmDefaultFaces(paletteWatch.read());
        stopsByWindow.set(
          view,
          paletteWatch.subscribe(() => {
            diagramPictures.warmDefaultFaces(paletteWatch.read());
          }),
        );
      }
    };
    watchOpenWindows();
    const stopHearing = openWindows.subscribe(watchOpenWindows);
    return () => {
      stopHearing();
      for (const stop of stopsByWindow.values()) {
        stop();
      }
    };
  }, [diagramPictures, openWindows]);
}
