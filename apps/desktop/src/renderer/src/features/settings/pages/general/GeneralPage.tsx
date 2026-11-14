// The General page: the facts about this build, the update block and the crash-report switch,
// then what a new session starts from and the machine's other preferences.
//
// Each `app` value is a string the main process chose, so it renders through `WireFigure`:
// verbatim, in mono, never re-cased or abbreviated. The update block draws the window's one
// reading of the updater, which the window binds, and this page's machine-settings binding. The
// rows under it draw only once the settings file has been read, so none shows a value the file
// does not hold; until then the update block's own line says the file is loading or unreadable,
// once for the page. A refused write leaves its control where it was and draws the refusal in the
// strip under it, with `Try again` sending the same change again.

import type { ReactNode } from "react";

import {
  MACHINE_SETTINGS_DEFAULTS,
  type LastLeadModel,
} from "@ai-sidekicks/contracts/machine/settings";
import type { ExecutionMode } from "@ai-sidekicks/contracts/repo/mount";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import {
  PreferenceChoiceRow,
  type PreferenceChoiceOption,
} from "../../components/PreferenceChoiceRow.js";
import { PreferenceToggleRow } from "../../components/PreferenceToggleRow.js";
import { SettingsFact } from "../../components/SettingsFact.js";
import {
  useMachineSettings,
  type MachineSettingsBinding,
} from "../../machine/hooks/useMachineSettings.js";
import type { MachineSettingsMember } from "../../machine/snapshot.js";
import type { SettingsControl, SettingsPageContext } from "../../types.js";
import { GENERAL_CONTROLS } from "./controls.js";
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
  const isSettingsRead = preferences.snapshot.reading !== undefined;
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
      {isSettingsRead ? (
        <>
          <section className="meridian-settings-page__block">
            {renderSwitch(preferences, "keepCrashReports", GENERAL_CONTROLS.keepCrashReports)}
          </section>
          <section className="meridian-settings-page__block">
            {renderSwitch(
              preferences,
              "newSessionCarriesLastModel",
              GENERAL_CONTROLS.startOnLastModel,
              lastUsedLine(settings.lastLeadModel),
            )}
            {renderSwitch(
              preferences,
              "keepAwakeWhileAgentWorks",
              app.platform === "darwin"
                ? GENERAL_CONTROLS.keepAwake
                : { ...GENERAL_CONTROLS.keepAwake, label: KEEP_COMPUTER_AWAKE_LABEL },
            )}
            <EditorChoiceRow bridge={bridge} preferences={preferences} clock={clock} />
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
            {renderWriteRefusal(preferences, "defaultCheckout")}
          </section>
        </>
      ) : null}
    </div>
  );
}

/** The switch's label on a computer that is not a Mac. */
const KEEP_COMPUTER_AWAKE_LABEL = "Keep this computer awake while a sidekick is working";

/** The two places a new project session can start, in the order the choice lists them. */
const CHECKOUT_ORDER: readonly ExecutionMode[] = ["provisionedWorktree", "boundRoot"];

/** Each place's entry in the choice. */
const CHECKOUT_OPTIONS: Readonly<Record<ExecutionMode, PreferenceChoiceOption>> = {
  provisionedWorktree: { value: "provisionedWorktree", label: "A new worktree" },
  boundRoot: { value: "boundRoot", label: "The checkout the project already has" },
};

/** The members whose rows on this page are switches. */
type GeneralSwitchMember =
  | "keepCrashReports"
  | "newSessionCarriesLastModel"
  | "keepAwakeWhileAgentWorks";

/** One switch over its member, with any line under its hint, and its refused write. */
function renderSwitch(
  preferences: MachineSettingsBinding,
  member: GeneralSwitchMember,
  control: SettingsControl,
  lineUnderHint?: string,
): ReactNode {
  return (
    <>
      <PreferenceToggleRow
        control={control}
        descriptionLines={[
          ...descriptionLinesOf(control),
          ...(lineUnderHint === undefined ? [] : [lineUnderHint]),
        ]}
        checked={preferences.settings[member]}
        checkedByDefault={MACHINE_SETTINGS_DEFAULTS[member]}
        isPending={preferences.isPending(member)}
        onCheckedChange={(checked) => {
          preferences.choose(member, checked);
        }}
      />
      {renderWriteRefusal(preferences, member)}
    </>
  );
}

/** The strip under a row while its member's last write was refused, with `Try again`. */
function renderWriteRefusal(
  preferences: MachineSettingsBinding,
  member: MachineSettingsMember,
): ReactNode {
  const refusal = preferences.refusalFor(member);
  return refusal === undefined ? null : (
    <InlineRefusal
      code={refusal.code}
      detail={refusal.detail}
      onTryAgain={() => {
        preferences.retry(member);
      }}
    />
  );
}

/** A control's hint as the row's one line, or no line where it has none. */
function descriptionLinesOf(control: SettingsControl): readonly string[] {
  return control.hint === undefined ? [] : [control.hint];
}

/** What a new session would carry, or nothing before the first model was picked. */
function lastUsedLine(lastLeadModel: LastLeadModel | null): string | undefined {
  if (lastLeadModel === null) {
    return undefined;
  }
  return lastLeadModel.effort === null
    ? `Last used: ${lastLeadModel.modelId}.`
    : `Last used: ${lastLeadModel.modelId}, at ${lastLeadModel.effort} effort.`;
}
