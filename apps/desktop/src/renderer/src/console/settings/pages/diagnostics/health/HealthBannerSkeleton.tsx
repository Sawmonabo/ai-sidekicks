// The health banner while it is being read.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health names this state
// exactly: "Loading: per-component skeletons." Rows rather than a spinner because the
// banner is the tallest thing on the page and a region that collapsed to a line and
// then grew back would move every reading below it as the read landed.
//
// ITS OWN MODULE because the package rule is one component per `.tsx`, and its own
// module is also the honest home: the skeleton knows the banner's row shape and
// nothing about health, so it takes no props and can never be handed a reading to
// half-render.

import type { ReactNode } from "react";

/** How many rows the skeleton draws. Three is the shape of a typical reply, not a cap. */
const SKELETON_ROW_KEYS: readonly string[] = ["first", "second", "third"];

export function HealthBannerSkeleton(): ReactNode {
  return (
    <div className="meridian-health-banner" aria-busy="true">
      <p className="meridian-health-banner__verdict meridian-health-banner__verdict--reading">
        Reading this machine&rsquo;s health.
      </p>
      <ul className="meridian-health-banner__components">
        {SKELETON_ROW_KEYS.map((rowKey) => (
          <li key={rowKey} className="meridian-health-banner__component" aria-hidden="true">
            <span className="meridian-health-banner__skeleton" />
          </li>
        ))}
      </ul>
    </div>
  );
}
