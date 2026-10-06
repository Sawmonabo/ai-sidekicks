// One settings page: its heading, its note, its body, and the landing an arrival asks for.
//
// A search hit moves focus to the heading, so the reader is on the page the hit opened; a hit or
// a link naming a control then lands on it, which moves focus on to the control and glides it
// into view through the scroll chokepoint.

import { useEffect, useRef, useState } from "react";

import type { SettingsPageRegistry } from "../pages/registry.js";
import type { SettingsPageContext } from "../types.js";
import { type SettingsPageId } from "#renderer/routing/settings-page-ids.js";
import { SETTINGS_PAGE_LABELS } from "../pages/labels.js";
import { useSettingsControlLanding } from "../hooks/useSettingsControlLanding.js";

/** Props for {@link SettingsPageContent}. */
export interface SettingsPageContentProps {
  readonly pageId: SettingsPageId;
  readonly context: SettingsPageContext;
  readonly pages: SettingsPageRegistry;
  /** Moves on every search hit, including a second hit on what is already open. */
  readonly hitOrdinal: number;
}

/**
 * The open page under its heading and note.
 *
 * Its own component because the landing needs the page body on screen; the pane's empty-state
 * arms stay hook-free.
 */
export function SettingsPageContent(props: SettingsPageContentProps): React.JSX.Element {
  const { pageId, context, hitOrdinal } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // State rather than a ref, so the landing starts again when the body element arrives.
  const [pageBody, setPageBody] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // Ordinal zero is the pane opening, not a hit.
    if (hitOrdinal !== 0) {
      headingRef.current?.focus();
    }
  }, [hitOrdinal]);
  useSettingsControlLanding({
    pageBody,
    pageId,
    controlId: context.selection,
    arrivalOrdinal: hitOrdinal,
  });

  const descriptor = props.pages.descriptorFor(pageId);
  const label = descriptor?.label ?? SETTINGS_PAGE_LABELS[pageId];
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
      <div className="meridian-settings__page-body" ref={setPageBody}>
        {descriptor?.render(context)}
      </div>
    </article>
  );
}
