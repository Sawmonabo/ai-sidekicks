import type { ClipboardCopy } from "#renderer/components/CopyButton/CopyButton.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useClipboardCopy } from "#renderer/services/platform/hooks/useClipboardCopy.js";

/**
 * A step tab's `Copy as JSON`: what the tab holds exactly as stored — a payload's items, or the
 * step's cost or error record — as indented JSON, whatever part of it is drawn, stringified only
 * when pressed. It says out loud what it copied, named by `label` (`Output of Summarize`), or that
 * it could not.
 */
export function usePayloadJsonCopy(stored: unknown, label: string): ClipboardCopy {
  const announce = useAnnounce();
  return useClipboardCopy(
    () => ({ text: JSON.stringify(stored, null, 2) }),
    (outcome) => {
      if (outcome === "copied") {
        announce(`${label} copied as JSON`);
      } else {
        announce(`Could not copy ${label}`, "assertive");
      }
    },
  );
}
