import type { ClipboardCopy } from "#renderer/components/CopyButton/CopyButton.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { writeJsonInPieces } from "#renderer/lib/json-text.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";

/**
 * A step tab's `Copy as JSON`: what the tab holds exactly as stored — a payload's items, or the
 * step's cost or error record — as indented JSON, whatever part of it is drawn, written only when
 * pressed, a slice at a time when it is long. It says out loud what it copied, named by `label`
 * (`Output of Summarize`), or that it could not.
 */
export function usePayloadJsonCopy(stored: unknown, label: string): ClipboardCopy {
  const announce = useAnnounce();
  const ownerWindow = useOwnerWindow();
  return useClipboardCopy(
    () => {
      const json = writeJsonInPieces(stored, 2, ownerWindow);
      return json instanceof Promise ? json.then((text) => ({ text })) : { text: json };
    },
    (outcome) => {
      if (outcome === "copied") {
        announce(`${label} copied as JSON`);
      } else {
        announce(`Could not copy ${label}`, "assertive");
      }
    },
  );
}
