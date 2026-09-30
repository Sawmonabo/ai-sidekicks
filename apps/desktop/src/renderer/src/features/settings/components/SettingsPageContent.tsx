// One settings page, and the settle that follows a search hit.
//
// The reader reaches the page by moving focus to its heading, not by a programmatic scroll:
// `scrollIntoView` is not allowed in this console and the transcript's scroll chokepoint owns
// scroll writes. The viewport following focus is the browser's own behavior. The settle is a
// CSS animation whose end clears it, so nothing here schedules a timer.

import { useEffect, useRef, useState } from "react";

import type { SettingsPageRegistry } from "../settings-pages.js";
import type { SettingsPageContext } from "../types.js";
import { type SettingsPageId } from "@renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "@renderer/features/settings/settings-page-labels.js";

/** Props for {@link SettingsPageContent}. */
export interface SettingsPageContentProps {
  readonly section: SettingsPageId;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /**
   * How many search hits this pane has opened. It moves on every hit, including a second hit
   * on the section already open.
   */
  readonly settleOrdinal: number;
}

/**
 * The selected section's page, and the settle that follows a search hit.
 *
 * Its own component because the settle effect needs a heading on screen; the pane's absence
 * arms stay hook-free.
 */
export function SettingsPageContent(props: SettingsPageContentProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [isSettling, setIsSettling] = useState(false);
  const { settleOrdinal } = props;

  useEffect(() => {
    // Ordinal zero is the pane opening, not a hit; settling then would flash on rail
    // navigation.
    if (settleOrdinal === 0) {
      return;
    }
    headingRef.current?.focus();
    setIsSettling(true);
  }, [settleOrdinal]);

  const descriptor = props.pages.descriptorFor(props.section);
  const label = SETTINGS_PAGE_LABELS[props.section];
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
      <div className="meridian-settings__page-body">{descriptor?.render(props.context)}</div>
    </article>
  );
}
