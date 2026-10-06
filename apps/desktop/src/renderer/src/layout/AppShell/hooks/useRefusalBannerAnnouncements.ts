// Says each newly raised refusal banner once, assertively, using the daemon's message unchanged.
// The code is left out of speech: it is a visual signature, and the banner still carries it in the
// accessibility tree. Route changes and dismissals are not announced.
//
// The banner list is re-supplied on every render, so the ids announced last pass are held (and
// replaced, not accumulated) to announce only raises; a banner dismissed and raised again speaks
// again.

import { useEffect, useRef } from "react";

import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import type { WindowBanner } from "#renderer/store/window/store.js";

/** Announces each newly raised refusal banner once, in the assertive region. */
export function useRefusalBannerAnnouncements(banners: readonly WindowBanner[]): void {
  const announce = useAnnounce();
  const announcedBannerIdsRef = useRef<ReadonlySet<string>>(undefined);

  useEffect(() => {
    const alreadyAnnounced = announcedBannerIdsRef.current;
    for (const banner of banners) {
      if (alreadyAnnounced?.has(banner.id) === true) {
        continue;
      }
      announce(banner.detail, "assertive");
    }
    announcedBannerIdsRef.current = new Set(banners.map((banner) => banner.id));
  }, [banners, announce]);
}
