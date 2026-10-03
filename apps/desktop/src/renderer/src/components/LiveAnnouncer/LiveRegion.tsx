// The two regions and the subscription that keeps them speaking. Not exported for features: the
// provider mounts the one pair, and a second would be a second speaker.
//
// Both the role and `aria-live` are written because support for the implied pairing is uneven
// across screen readers, and an unannounced region looks like one nothing was sent to.
// `aria-atomic="true"` must not be left implicit, or a reader may speak only a changed text node.

import { useCallback, useSyncExternalStore } from "react";

import { LiveAnnouncer } from "./live-announcer.js";

/**
 * The two regions, rendered once per window and never conditionally. Uses
 * `useSyncExternalStore` so an announcement raised before the subscription is not missed.
 */
export function LiveRegion(props: LiveRegionProps): React.JSX.Element {
  const { announcer } = props;
  const subscribe = useCallback(
    (onStoreChange: () => void) => announcer.subscribe(onStoreChange),
    [announcer],
  );
  const read = useCallback(() => announcer.state, [announcer]);
  const announced = useSyncExternalStore(subscribe, read, read);
  return (
    <>
      <div
        className="meridian-visually-hidden"
        data-live-region="polite"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announced.polite}
      </div>
      <div
        className="meridian-visually-hidden"
        data-live-region="assertive"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {announced.assertive}
      </div>
    </>
  );
}

interface LiveRegionProps {
  readonly announcer: LiveAnnouncer;
}
