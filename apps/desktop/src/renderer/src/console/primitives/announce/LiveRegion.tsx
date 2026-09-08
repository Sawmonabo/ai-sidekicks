// The two regions, and the subscription that keeps them speaking.
//
// Its own module because `apps/desktop/AGENTS.md` puts one component in a `.tsx`
// file, and the reason that rule holds here rather than being a formality: the
// provider beside it decides WHO owns an announcer and for how long, and this
// decides what an announcement looks like in the accessibility tree. Two decisions,
// two modules. It is not exported through the family door — the console has one
// announcer per window and the provider mounts its pair, so a family that reached
// for this directly would be the second speaker `LiveAnnouncerProvider` exists to
// make unrepresentable.
//
// WHY BOTH THE ROLE AND THE `aria-live` ATTRIBUTE. `role="status"` and
// `role="alert"` already imply `aria-live="polite"` / `"assertive"` and
// `aria-atomic="true"`, so the attributes are redundant on paper. They are written
// anyway because the redundancy is free and the failure it covers is silent: the
// pairing is honoured unevenly across screen-reader and browser combinations, and a
// region that is not announced looks exactly like a region nothing was sent to.
// `aria-atomic="true"` is the part that is NOT safely left implicit — without it a
// reader may speak only the changed text node, which for a message replacing a
// message is a fragment of a sentence.

import { useCallback, useSyncExternalStore } from "react";

import { LiveAnnouncer } from "./live-announcer.js";

interface LiveRegionProps {
  readonly announcer: LiveAnnouncer;
}

/**
 * The two regions. Rendered once per window and never conditionally.
 *
 * `useSyncExternalStore` rather than a `useState` an effect writes into: an
 * announcement raised between this component's render and its subscription would be
 * missed by the effect shape, and a missed announcement is silent by construction.
 * The announcer holds one snapshot object between changes, so the comparison is a
 * pointer check and an unchanged region costs no render.
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
