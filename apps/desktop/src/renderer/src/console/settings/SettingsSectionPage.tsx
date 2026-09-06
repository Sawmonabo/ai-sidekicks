// One settings page, and the settle that follows a search hit.
//
// HOW THE READER GETS THERE, AND WHY IT IS NOT A PROGRAMMATIC SCROLL. The design
// asks for "a match names where it landed, scrolls into the pane, and settles with
// one brief highlight". Two of the three are this file's; the scroll is the
// PLATFORM's, reached by moving focus to the page's heading. `scrollIntoView` is a
// standing tripwire in this console, and the programmatic-scroll chokepoint the
// ledger family owns does not exist in this tree yet — so a scroll writer minted
// here would be exactly the second one that rule exists to prevent. Focus is not a
// scroll writer: it is what a keyboard reader needs anyway, and the viewport
// following it is the browser's own behaviour rather than this module's.
//
// AND WHY THE SETTLE IS AN ANIMATION RATHER THAN A TIMER. A highlight cleared on a
// timer would be a second clock in a console whose timers are chokepointed; the
// animation's own end is the signal, so nothing here schedules anything, and a
// reader whose system asks for reduced motion gets no animation and therefore no
// lingering highlight to clear.

import { useEffect, useRef, useState } from "react";

import { Nothing } from "../primitives/index.js";
import {
  SETTINGS_SECTION_LABELS,
  type SettingsPageContext,
  type SettingsPageRegistry,
  type SettingsSectionId,
} from "./settings-page-registry.js";

export interface SettingsSectionPageProps {
  readonly section: SettingsSectionId;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /**
   * How many search hits this surface has opened. Moves on every hit, including a
   * second hit on the section already open — the case a boolean could not express,
   * and the one where a reader most needs to be told they did not move.
   */
  readonly settleOrdinal: number;
}

/**
 * The selected section's page, and the settle that follows a search hit.
 *
 * Its own component because the hooks below may not be called from the arms above:
 * an address naming no section renders no page, and a component that ran the settle
 * effect anyway would be reaching for a heading that is not on screen. The surface's
 * three absence arms stay hook-free, which is what makes that safe by construction
 * rather than by an early-return convention.
 */
export function SettingsSectionPage(props: SettingsSectionPageProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [isSettling, setIsSettling] = useState(false);
  const { settleOrdinal } = props;

  useEffect(() => {
    // Ordinal zero is the surface opening rather than a hit, so nothing settles
    // before anybody has searched — a page that flashed on arrival would be saying
    // "you landed here" to a person who navigated by the rail.
    if (settleOrdinal === 0) {
      return;
    }
    headingRef.current?.focus();
    setIsSettling(true);
  }, [settleOrdinal]);

  const descriptor = props.pages.descriptorFor(props.section);
  const label = SETTINGS_SECTION_LABELS[props.section];
  return (
    <article
      className={
        isSettling
          ? "meridian-settings__page meridian-settings__page--settling"
          : "meridian-settings__page"
      }
      aria-label={label}
      onAnimationEnd={() => {
        setIsSettling(false);
      }}
    >
      <h2 className="meridian-settings__page-heading" ref={headingRef} tabIndex={-1}>
        {descriptor?.label ?? label}
      </h2>
      <div className="meridian-settings__page-body">
        {descriptor === undefined ? (
          <Nothing
            kind="empty"
            placement="surface"
            title={`The ${label.toLowerCase()} page has not been built yet.`}
            detail="It is reserved rather than missing — the section exists and its page is still being built. Nothing was asked of the daemon for it."
          />
        ) : (
          descriptor.render(props.context)
        )}
      </div>
    </article>
  );
}
