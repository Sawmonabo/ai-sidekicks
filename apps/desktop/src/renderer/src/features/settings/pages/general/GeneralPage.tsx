// The General page: the facts about this build.
//
// Each `app` value is a string the main process chose, so it renders through `WireFigure`:
// verbatim, in mono, never re-cased or abbreviated.

import type { ReactNode } from "react";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { SettingsPageContext } from "../../types.js";

/** The General page: the running version, platform, architecture and locale. */
export function GeneralPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge } = props.context;
  const { app } = bridge;
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
