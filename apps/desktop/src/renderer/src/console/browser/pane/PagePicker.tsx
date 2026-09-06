// The page picker: every page the session owns, including the ones nobody is looking
// at.
//
// `Spec-023 §Console Design (Meridian)` 12.2 Renders: "A page picker listing every
// page the session owns with its label, title, and host, including background pages
// the agent opened but never showed." That last clause is the whole reason the picker
// exists beside the strip — a background page is a page an agent is working in, and a
// surface that only listed what is on screen would hide most of what is happening.
//
// FOUR CONTROLS PER ROW AND EACH IS THE DESIGN'S OWN. Show (12.2's `show` action, the
// explicit act that puts a background page in front of a person), select (`select`,
// which pins the tab WITHOUT changing visibility — the separation that keeps the pane
// watchable), developer tools, and reveal-in-file-manager for a page that is a local
// file.
//
// DEVELOPER TOOLS IS ABSENT AND NOT DISABLED where the host could not be created.
// 12.2's Degraded state says so, and names the discipline it is matching: a control
// that is present and refuses teaches a person to try it again. The pane knows
// whether it has a host, so the pane tells the picker.
//
// REVEAL CARRIES NO PATH, in either direction. The act names the pane and the page;
// where the file is, and whether the file manager may be told about it, are resolved
// where the page is. The row's own test for whether to offer it at all is the
// destination the wire reported, read through this family's single
// filesystem-destination predicate rather than a second `startsWith("file:")`.

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { ChromeControl } from "./ChromeControl.js";
import type { BrowserChromeActs } from "./chrome-acts.js";
import { isFilesystemDestination } from "./navigation-state.js";
import { pagesOf, type PageListReading } from "./page-state.js";

export interface PagePickerProps {
  readonly reading: PageListReading;
  readonly acts: BrowserChromeActs;
  /** False where the host could not be created, which makes the control absent. */
  readonly canOpenDevtools: boolean;
}

export function PagePicker(props: PagePickerProps): React.JSX.Element {
  const { reading, acts, canOpenDevtools } = props;
  const pages = pagesOf(reading);

  if (reading.kind === "refused") {
    return <InlineRefusal {...reading.refusal} />;
  }
  if (reading.kind === "reading") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Pages not read"
        detail="No answer has come back about which pages this session owns, so this list is not a list of none."
      />
    );
  }
  if (reading.kind === "ended") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Pages no longer reported"
        detail="The producer that listed this session's pages finished, so this list is the last thing it said rather than what is open now."
      />
    );
  }
  if (pages.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No pages open"
        detail="This session owns no pages, in the pane or in the background."
      />
    );
  }

  return (
    <ul className="meridian-browser-picker">
      {pages.map((page) => (
        <li key={page.pageId} className="meridian-browser-picker__row">
          <div className="meridian-browser-picker__identity">
            <span className="meridian-browser-picker__label">
              {page.label !== null && page.label.length > 0 ? (
                page.label
              ) : (
                <span className="meridian-browser-picker__unlabelled">Unlabelled</span>
              )}
            </span>
            <span className="meridian-browser-picker__title">{page.title}</span>
            <span className="meridian-browser-picker__host">{page.host}</span>
            {page.isShown ? null : (
              <span className="meridian-browser-picker__background">background</span>
            )}
          </div>
          <div className="meridian-browser-picker__controls">
            <ChromeControl
              label="Show"
              disabled={page.isShown}
              onActivate={() => {
                acts.showPage(page.pageId);
              }}
            />
            <ChromeControl
              label="Select"
              disabled={page.isSelected}
              onActivate={() => {
                acts.selectPage(page.pageId);
              }}
            />
            {canOpenDevtools ? (
              <ChromeControl
                label="Developer tools"
                onActivate={() => {
                  acts.openDevtools(page.pageId);
                }}
              />
            ) : null}
            {isFilesystemDestination(page.url) ? (
              <ChromeControl
                label="Reveal file"
                onActivate={() => {
                  acts.revealPageFile(page.pageId);
                }}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
