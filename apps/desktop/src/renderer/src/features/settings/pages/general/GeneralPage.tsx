// The General page: the facts about this build, the update block and the crash-report switch,
// then what a new session starts from and the machine's other preferences.
//
// Each `app` value is a string the main process chose, so it renders through `WireFigure`:
// verbatim, in mono, never re-cased or abbreviated. The update block draws the window's one
// reading of the updater, which the window binds, and this page's machine-settings binding. Every
// row kept in the settings file stands from the first frame with its label, reading `Loading…` or
// the failed read with `Try again` in its control's place until the file is read, so none shows a
// value the file does not hold and the page does not move when the read lands. A refused write
// leaves its control where it was and draws the refusal in the strip under it, with `Try again`
// sending the same change again.

import type { ReactNode } from "react";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type LastLeadModel,
} from "@ai-sidekicks/contracts/machine/settings";
import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { MachineSettingRow } from "../../components/MachineSettingRow.js";
import { MachineSettingSwitchRow } from "../../components/MachineSettingSwitchRow.js";
import {
  PreferenceChoiceRow,
  type PreferenceChoiceOption,
} from "../../components/PreferenceChoiceRow.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import { useMachineSettings } from "../../machine/hooks/useMachineSettings.js";
import type { SettingsControl, SettingsPageContext } from "../../types.js";
import { GENERAL_CONTROLS, keepAwakeControlOn } from "./controls.js";
import { EditorChoiceRow } from "./editor/EditorChoiceRow.js";
import { UpdatesBlock } from "./updates/UpdatesBlock.js";

/**
 * The General page: the running version, platform, architecture and locale, the update block and
 * the crash-report switch, then the machine's preferences for new sessions and opening files.
 */
export function GeneralPage(props: { readonly context: SettingsPageContext }): ReactNode {
  const { bridge, updateReading } = props.context;
  const { app } = bridge;
  const preferences = useMachineSettings(bridge);
  const clock = useClock();
  const { settings } = preferences;
  const keepAwakeControl = keepAwakeControlOn(app.platform);
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
      <section className="meridian-settings-page__block">
        <MachineSettingSwitchRow
          preferences={preferences}
          member="keepCrashReports"
          control={GENERAL_CONTROLS.keepCrashReports}
          descriptionLines={descriptionLinesOf(GENERAL_CONTROLS.keepCrashReports)}
          clock={clock}
        />
      </section>
      <section className="meridian-settings-page__block">
        <MachineSettingSwitchRow
          preferences={preferences}
          member="newSessionCarriesLastModel"
          control={GENERAL_CONTROLS.startOnLastModel}
          descriptionLines={[
            ...descriptionLinesOf(GENERAL_CONTROLS.startOnLastModel),
            ...lastUsedLines(settings.lastLeadModel),
          ]}
          clock={clock}
        />
        <MachineSettingSwitchRow
          preferences={preferences}
          member="keepAwakeWhileAgentWorks"
          control={keepAwakeControl}
          descriptionLines={descriptionLinesOf(keepAwakeControl)}
          clock={clock}
        />
        <EditorChoiceRow bridge={bridge} preferences={preferences} clock={clock} />
        <MachineSettingRow
          preferences={preferences}
          member="defaultCheckout"
          control={GENERAL_CONTROLS.defaultCheckout}
          descriptionLines={descriptionLinesOf(GENERAL_CONTROLS.defaultCheckout)}
          clock={clock}
          renderControlRow={() => (
            <PreferenceChoiceRow
              control={GENERAL_CONTROLS.defaultCheckout}
              descriptionLines={descriptionLinesOf(GENERAL_CONTROLS.defaultCheckout)}
              options={CHECKOUT_ORDER.map((mode) => CHECKOUT_OPTIONS[mode])}
              value={settings.defaultCheckout}
              defaultOption={CHECKOUT_OPTIONS[MACHINE_SETTINGS_DEFAULTS.defaultCheckout]}
              isPending={preferences.isPending("defaultCheckout")}
              onChoose={(value) => {
                const mode = CHECKOUT_ORDER.find((candidate) => candidate === value);
                if (mode !== undefined) {
                  preferences.choose("defaultCheckout", mode);
                }
              }}
            />
          )}
        />
      </section>
    </div>
  );
}

/** The two places a new project session can start, in the order the choice lists them. */
const CHECKOUT_ORDER: readonly ExecutionMode[] = ["provisionedWorktree", "boundRoot"];

/** Each place's entry in the choice. */
const CHECKOUT_OPTIONS: Readonly<Record<ExecutionMode, PreferenceChoiceOption>> = {
  provisionedWorktree: { value: "provisionedWorktree", label: "A new worktree" },
  boundRoot: { value: "boundRoot", label: "The checkout the project already has" },
};

/** A control's hint as the row's one line, or no line where it has none. */
function descriptionLinesOf(control: SettingsControl): readonly string[] {
  return control.hint === undefined ? [] : [control.hint];
}

/**
 * What a new session would carry, its model and effort drawn as the wire sent them, or no line
 * before the first model was picked.
 */
function lastUsedLines(lastLeadModel: LastLeadModel | null): readonly ReactNode[] {
  if (lastLeadModel === null) {
    return [];
  }
  const model = <WireFigure value={lastLeadModel.modelId} />;
  return [
    lastLeadModel.effort === null ? (
      <>Last used: {model}.</>
    ) : (
      <>
        Last used: {model}, at <WireFigure value={lastLeadModel.effort} /> effort.
      </>
    ),
  ];
}
