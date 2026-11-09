// The General page: the facts about this build, then the update block.
//
// Each `app` value is a string the main process chose, so it renders through `WireFigure`:
// verbatim, in mono, never re-cased or abbreviated. The update block draws the window's one
// reading of the updater, which the window binds, and this page's machine-settings binding.

import type { ReactNode } from "react";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import { useMachineSettings } from "../../machine/hooks/useMachineSettings.js";
import type { SettingsPageContext } from "../../types.js";
import { GENERAL_CONTROLS } from "./controls.js";
import { UpdatesBlock } from "./updates/UpdatesBlock.js";

/** The General page: the running version, platform, architecture and locale, then updates. */
export function GeneralPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, updateReading } = props.context;
  const { app } = bridge;
  const preferences = useMachineSettings(bridge);
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
      <UpdatesBlock
        reading={updateReading.reading}
        onReadAgain={updateReading.readAgain}
        runningVersion={app.version}
        updater={bridge.update}
        preferences={preferences}
      />
    </div>
  );
}
