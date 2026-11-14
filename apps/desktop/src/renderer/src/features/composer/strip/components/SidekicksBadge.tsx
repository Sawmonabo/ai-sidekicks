// The strip's Sidekicks badge: the robot and the count of children the session dispatched, read
// off the session's child-run links read the Sidekicks pane shares. Pressing it opens the
// Sidekicks pane on its list.

import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import {
  createChildRunLinks,
  readChildRunLinks,
} from "#renderer/services/daemon/child-run-links.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";
import { useSessionChildRunLinks } from "#renderer/store/session/hooks/useSessionChildRunLinks.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { readSidekicksBadge } from "../badge.js";

/** What the badge reads, the session whose children it counts, and what its press opens. */
export interface SidekicksBadgeProps {
  readonly bridge: PlatformBridge;
  readonly sessionStore: SessionStore;
  /** Open the Sidekicks pane on its list. */
  readonly openSidekicks: () => void;
}

/** The badge, or `null` while the session dispatched nothing. */
export function SidekicksBadge(props: SidekicksBadgeProps): React.JSX.Element | null {
  const clock = useClock();
  const links = useSessionChildRunLinks(props.sessionStore, () =>
    createChildRunLinks(props.bridge, props.sessionStore, clock, readChildRunLinks),
  );
  const reading = usePushDrivenRead(links);
  const badge = readSidekicksBadge(reading.kind === "loaded" ? reading.value.counts : undefined);
  if (badge.kind === "hidden") {
    return null;
  }
  const waitingClass = badge.isWaiting ? " meridian-composer-strip__badge--waiting" : "";
  return (
    <button
      type="button"
      className={`meridian-composer-strip__badge${waitingClass}`}
      aria-label={`Sidekicks ${String(badge.count)}`}
      onClick={props.openSidekicks}
    >
      <Glyph name="agent" />
      <span className={badge.isCountDimmed ? "meridian-composer-strip__count--dimmed" : undefined}>
        {badge.count}
      </span>
    </button>
  );
}
