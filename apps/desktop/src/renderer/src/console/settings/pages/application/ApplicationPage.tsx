// The application page: facts about this build, how it updates, and what it reports
// when it fails.
//
// WHY THIS PAGE EXISTS AND THE OTHER TWO ARE BLOCKS
//
// The design enumerates the settings sections and neither `updates` nor
// `crash-reporting` is one of them, while its own §Application updates and §Crash
// reporting sections are each one row plus a line ("One row plus its state line";
// "One row, copy inline, no disclosure"). Two rows about the application itself are
// one page, so this module claims the `application` section and composes them.
// Splitting them into two registrations would need two ids the design does not name
// for two rows it already places on one page — the opposite of the `sidekicks` case,
// which is a page the design places in settings with no id to reach it by.
//
// THE BUILD FACTS ARE WIRE-VERBATIM
//
// `app` is the one bridge namespace that carries values rather than calls, and every
// one of them is a string the shell chose. They render through `WireFigure`, which
// is the console's rule for a value it did not compute: verbatim, in mono, never
// re-cased and never abbreviated.

import type { ReactNode } from "react";

import { WireFigure } from "../../../primitives/index.js";
import { CrashReportingBlock } from "./crash-reporting/CrashReportingBlock.js";
import { UpdatesBlock } from "./updates/UpdatesBlock.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-application";

export function ApplicationPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge } = props.context;
  const { app } = bridge.sidekicks;
  return (
    <div className="meridian-settings-page">
      <dl className="meridian-settings-page__facts">
        <div className="meridian-settings-page__fact">
          <dt>Version</dt>
          <dd>
            <WireFigure value={app.version} />
          </dd>
        </div>
        <div className="meridian-settings-page__fact">
          <dt>Platform</dt>
          <dd>
            <WireFigure value={app.platform} />
          </dd>
        </div>
        <div className="meridian-settings-page__fact">
          <dt>Architecture</dt>
          <dd>
            <WireFigure value={app.arch} />
          </dd>
        </div>
        <div className="meridian-settings-page__fact">
          <dt>Locale</dt>
          <dd>
            <WireFigure value={app.locale} />
          </dd>
        </div>
      </dl>

      <UpdatesBlock bridge={bridge} />
      <CrashReportingBlock bridge={bridge} />
    </div>
  );
}

/** Claim the application section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerApplicationPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "application",
    owner: OWNER,
    label: "Application",
    keywords: [
      "updates",
      "version",
      "restart",
      "release",
      "crash reports",
      "crash reporting",
      "about",
      "build",
    ],
    render: (context) => <ApplicationPage context={context} />,
  });
}
