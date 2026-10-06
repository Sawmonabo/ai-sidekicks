import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { OpenWindowFrames } from "#renderer/lib/open-window-frames.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { OpenWindows, type WindowOpener } from "#renderer/services/window/open-windows.js";

/**
 * The windows the console document opens through `openWindow`, pacing `frames`, held for the
 * mount and disposed with it; a remount after a disposal gets a fresh one.
 */
export function useOpenWindows(openWindow: WindowOpener, frames: OpenWindowFrames): OpenWindows {
  const { value: openWindows } = useSubjectScopedResource(
    frames,
    undefined,
    () => new OpenWindows({ openWindow, consoleDocument: document, frames }),
    CONTROLLER_DISPOSAL,
  );
  return openWindows;
}
