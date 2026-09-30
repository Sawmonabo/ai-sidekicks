// Says on the session screen that the remembered read position was refused and the log was
// re-read from the start; the recovery is otherwise invisible. It has no `onDismiss`, so it
// clears when the next completed read resumes normally, and it renders above the session
// screen body, never in place of it: only a remembered position was lost, not the stream.

import { RefusalBanner } from "@renderer/components/Refusal/RefusalBanner.js";
import { useTimelineResume } from "@renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";

/** Props for `ResumeRefusalBanner`. */
export interface ResumeRefusalBannerProps {
  readonly registry: SessionStoreRegistry;
  readonly sessionId: string;
}

/**
 * The banner for a refused resume position, or null for every other decision and before any
 * read has landed; a first read still in flight is already rendered as loading.
 */
export function ResumeRefusalBanner(props: ResumeRefusalBannerProps): React.JSX.Element | null {
  const decision = useTimelineResume(props.registry, props.sessionId);
  if (decision === undefined || decision.outcome !== "refused") {
    return null;
  }
  // Spread so the code and the sentence are the daemon's own.
  return <RefusalBanner {...decision.refusal} />;
}
