// One settings page: its heading, its note, its body, and the landing an arrival asks for.
//
// A search hit moves focus to the heading, so the reader is on the page the hit opened; a hit or
// a link naming a control then lands on it, which moves focus on to the control and glides it
// into view through the scroll chokepoint. What the page draws as it opens stands: its lines are
// read by browsing, and only a line that appears or changes after is said.

import { useLayoutEffect, useRef, useState } from "react";

import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import type { SettingsPageRegistry } from "../pages/registry.js";
import type { SettingsPageContext } from "../types.js";
import { type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "../pages/labels.js";
import { useSettingsControlLanding } from "../hooks/useSettingsControlLanding.js";
import type { PendingSearchHit } from "../pending-search-hit.js";

/** Props for {@link SettingsPageContent}. */
export interface SettingsPageContentProps {
  readonly pageId: SettingsPageId;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /** Moves on every search hit, including a second hit on what is already open. */
  readonly hitOrdinal: number;
  /** The search hit waiting for the page it opened, which this page takes once. */
  readonly pendingSearchHit: PendingSearchHit;
}

/**
 * The open page under its heading and note.
 *
 * Its own component because the landing needs the page body on screen; the pane's empty-state
 * arms stay hook-free.
 */
export function SettingsPageContent(props: SettingsPageContentProps): React.JSX.Element {
  const { pageId, context, hitOrdinal, pendingSearchHit } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // State rather than a ref, so the landing starts again when the body element arrives.
  const [pageBody, setPageBody] = useState<HTMLDivElement | null>(null);

  const descriptor = props.pages.descriptorFor(pageId);
  // Only a control the page declares is landed on; any other selection is the page's own.
  const landedControlId = descriptor?.controls.some((control) => control.id === context.selection)
    ? context.selection
    : undefined;
  const label = SETTINGS_PAGE_LABELS[pageId];

  // Before the landing, which runs after it and moves focus on to the control it lands on.
  useLayoutEffect(() => {
    // Only the arrival a search hit made: a later open by the list, a link or Back keeps focus.
    if (pendingSearchHit.take(pageId)) {
      headingRef.current?.focus();
    }
  }, [hitOrdinal, pageId, pendingSearchHit]);
  useSettingsControlLanding({ pageBody, pageId, controlId: landedControlId, hitOrdinal });

  return (
    <article className="meridian-settings__page" aria-label={label}>
      <header className="meridian-settings__page-head">
        <h2 className="meridian-settings__page-heading" ref={headingRef} tabIndex={-1}>
          {label}
        </h2>
        {descriptor === undefined ? null : (
          <p className="meridian-settings__page-note">{descriptor.note}</p>
        )}
      </header>
      <div ref={setPageBody}>
        <StandingContent key={pageId}>{descriptor?.render(context)}</StandingContent>
      </div>
    </article>
  );
}
