// The General page: the facts about this build.
//
// Each `app` value is a string the main process chose, so it renders through `WireFigure`:
// verbatim, in mono, never re-cased or abbreviated.

import type { ReactNode } from "react";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import type { SettingsPageContext } from "../../types.js";
import { GENERAL_CONTROLS } from "./controls.js";

/** The General page: the running version, platform, architecture and locale. */
export function GeneralPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge } = props.context;
  const { app } = bridge;
  return (
    <div className="meridian-settings-page">
      <dl className="meridian-settings-page__facts">
        <SettingsFact control={GENERAL_CONTROLS.version}>
          <WireFigure value={app.version} />
        </SettingsFact>
        <SettingsFact control={GENERAL_CONTROLS.platform}>
          <WireFigure value={app.platform} />
        </SettingsFact>
        <SettingsFact control={GENERAL_CONTROLS.architecture}>
          <WireFigure value={app.arch} />
        </SettingsFact>
        <SettingsFact control={GENERAL_CONTROLS.language}>
          <WireFigure value={app.locale} />
        </SettingsFact>
      </dl>
    </div>
  );
}
