// The strip's Sidekicks badge: the robot and the count of children the session dispatched, read
// off the child-run links the Sidekicks pane reads too.

import { useEffect } from "react";

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import {
  createChildRunLinks,
  readChildRunLinks,
} from "#renderer/services/daemon/child-run-links.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { readSidekicksBadge } from "../badge.js";

/** What the badge reads: the session whose children it counts. */
export interface SidekicksBadgeProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
}

/** The badge, or `null` while the session dispatched nothing. */
export function SidekicksBadge(props: SidekicksBadgeProps): React.JSX.Element | null {
  const clock = useClock();
  const { value: links } = useSubjectScopedResource(
    props.sessionStore,
    props.sessionStore.sessionId,
    () => createChildRunLinks(props.bridge, props.sessionStore, clock, readChildRunLinks),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    links.start();
  }, [links]);
  const reading = usePushDrivenRead(links);
  const badge = readSidekicksBadge(reading.kind === "loaded" ? reading.value.counts : undefined);
  if (badge.kind === "hidden") {
    return null;
  }
  return (
    <span
      className={`meridian-composer-strip__badge${badge.isWaiting ? " meridian-composer-strip__badge--waiting" : ""}`}
      aria-label={`Sidekicks ${String(badge.count)}`}
    >
      <Glyph name="agent" />
      <span className={badge.isCountDimmed ? "meridian-composer-strip__count--dimmed" : undefined}>
        {badge.count}
      </span>
    </span>
  );
}
