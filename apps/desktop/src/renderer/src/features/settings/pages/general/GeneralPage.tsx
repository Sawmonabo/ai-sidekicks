// The application page: the facts about this build.
//
// `app` is the one bridge namespace that carries values rather than calls, and every one
// of them is a string the shell chose. They render through `WireFigure`, which is the
// console's rule for a value it did not compute: verbatim, in mono, never re-cased and
// never abbreviated.
//
// `updates/UpdatesBlock.tsx` and `crash-reporting/CrashReportingBlock.tsx` are the two
// blocks that sit beside these facts; each is its own component.

import type { ReactNode } from "react";

import { WireFigure } from "@renderer/console/primitives/index.js";
import type { SettingsPageContext, SettingsPageRegistry } from "../../settings-pages.js";

/** The owner this page registers under. */
const OWNER = "settings-application";

/** The application page: the running version, platform, architecture and locale. */
export function ApplicationPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge } = props.context;
  const { app } = bridge.desktopBridge;
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
    </div>
  );
}

/** Claim the application section. */
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
