// The browser settings page, bound to a bridge.
//
// TWO MODULES BECAUSE THERE ARE TWO JOBS. `BrowserSettingsPage.tsx` projects what it
// is handed and reads nothing, which is what lets a screenshot tier and an auxiliary
// window render it without a second code path. This one performs the reads — through
// `browser-settings-source.ts` beside it — and hands the projection over. The settings
// board mounts THIS one, so the page keeps its property and the section is still
// reachable from the rail.
//
// WHAT IT DELIBERATELY DOES NOT HAND DOWN IS `onClosePane`. Chapter 13.16 orders the
// clear after a pane close, and no verb anywhere in this console closes another
// surface's browser pane — the growth port carries five pane-keyed navigation verbs
// and no close. Passing a stand-in that resolved `done` would report a pane closed
// that is still open, so the prop is absent and the clear control refuses by name on
// a partition whose pane is open, which is the behaviour its own sequence specifies.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { BrowserSettingsPage } from "./BrowserSettingsPage.js";
import { useBrowserSettingsSource } from "./browser-settings-source.js";

export interface BrowserSettingsSectionProps {
  readonly bridge: ConsoleBridge;
}

export function BrowserSettingsSection(props: BrowserSettingsSectionProps): ReactNode {
  const source = useBrowserSettingsSource(props.bridge);
  return (
    <BrowserSettingsPage
      switchReadings={source.switchReadings}
      onToggleSwitch={source.toggleSwitch}
      partitions={source.partitions}
      onClearSiteData={source.clearSiteData}
    />
  );
}
