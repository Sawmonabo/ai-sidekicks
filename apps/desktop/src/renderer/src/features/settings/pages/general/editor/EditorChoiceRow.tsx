// `Editor that opens files`: `System default`, then every editor the app looks for. One this
// machine lacks keeps its place, dimmed, cannot be picked and reads `(not installed)` after its
// name. A chosen editor this machine does not have draws the line that says files open in the
// system default, which is where main opens them; one the list no longer names at all stands as
// the value with no words in the choice, since no name is known for it, so `System default` can
// still be picked. The row stands with its label from the first frame, as every settings-file
// control's does, and the editors are read once the file has been.

import { useState, type ReactNode } from "react";

import type { EditorEntry } from "#shared/preload-api.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  PreferenceChoiceRow,
  type PreferenceChoiceOption,
} from "#renderer/features/settings/components/PreferenceChoiceRow.js";
import { MachineSettingRow } from "#renderer/features/settings/components/MachineSettingRow.js";
import { PreferenceRow } from "#renderer/features/settings/components/PreferenceRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { GENERAL_CONTROLS } from "../controls.js";
import { useEditorList } from "./hooks/useEditorList.js";

/** What the editor row is handed. */
export interface EditorChoiceRowProps {
  /** The bridge main's editor list is read through. */
  readonly bridge: PlatformBridge;
  /** The machine settings the choice reads and writes. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "settings" | "isPending" | "refusalFor" | "choose" | "retry" | "readAgain"
  >;
  /** The window's clock, which the list's reads and the reading line's delay run on. */
  readonly clock: Clock;
}

/**
 * The editor row: its label with the settings file's reading or failed line until the file is
 * read, then the choice once main has listed the editors, or the list's own reading or failed line.
 */
export function EditorChoiceRow(props: EditorChoiceRowProps): ReactNode {
  return (
    <MachineSettingRow
      preferences={props.preferences}
      member="editorId"
      control={GENERAL_CONTROLS.editor}
      descriptionLines={[]}
      clock={props.clock}
      renderControlRow={() => <EditorChoice {...props} />}
    />
  );
}

/** `System default`, the first entry and the value `null` stands for. */
const SYSTEM_DEFAULT_OPTION: PreferenceChoiceOption = { value: "", label: "System default" };

/** The code the line for a chosen editor this machine does not have is drawn under. */
const EDITOR_NOT_FOUND_CODE = "editor-not-found";

/** The line for a chosen editor this machine does not have. */
const EDITOR_NOT_FOUND_LINE =
  "That editor could not be found. Pick another, or files open in the system default.";

// The choice over the editors main lists, mounted once the settings file has been read.
function EditorChoice(props: EditorChoiceRowProps): ReactNode {
  const { preferences } = props;
  const editors = useEditorList(props.bridge, props.clock);
  // A read's `Try again` can end in the same words; the press count says them again.
  const [readAgainCount, setReadAgainCount] = useState(0);
  const chosenEditorId = preferences.settings.editorId;
  if (editors.state.kind !== "loaded") {
    const { state } = editors;
    return (
      <>
        <PreferenceRow
          control={GENERAL_CONTROLS.editor}
          controlElementId={undefined}
          descriptionLines={[]}
          changedFromDefault={
            chosenEditorId === null
              ? undefined
              : { defaultDescription: `${SYSTEM_DEFAULT_OPTION.label} by default` }
          }
          renderControl={() =>
            state.kind === "not-loaded" ? (
              <LoadingNotice clock={props.clock} placement="inline" title="Loading…" />
            ) : null
          }
        />
        {state.kind === "failed" ? (
          <InlineRefusal
            code={state.refusal.code}
            detail="Couldn't load editors"
            onTryAgain={() => {
              setReadAgainCount((count) => count + 1);
              editors.readAgain();
            }}
            attempt={readAgainCount}
          />
        ) : null}
      </>
    );
  }
  const entries = editors.state.value;
  const isChosenEditorMissing =
    chosenEditorId !== null &&
    !entries.some((entry) => entry.id === chosenEditorId && entry.installed);
  return (
    <>
      <PreferenceChoiceRow
        control={GENERAL_CONTROLS.editor}
        options={editorOptions(entries, chosenEditorId)}
        value={chosenEditorId ?? SYSTEM_DEFAULT_OPTION.value}
        defaultOption={SYSTEM_DEFAULT_OPTION}
        isPending={preferences.isPending("editorId")}
        onChoose={(value) => {
          preferences.choose("editorId", value === SYSTEM_DEFAULT_OPTION.value ? null : value);
        }}
      />
      {isChosenEditorMissing ? (
        <InlineRefusal code={EDITOR_NOT_FOUND_CODE} detail={EDITOR_NOT_FOUND_LINE} isStanding />
      ) : null}
    </>
  );
}

/**
 * `System default`, then each listed editor, one this machine lacks dimmed and unpickable. A
 * chosen id the list does not name stands as the value, blank and never listed.
 */
function editorOptions(
  entries: readonly EditorEntry[],
  chosenEditorId: string | null,
): readonly PreferenceChoiceOption[] {
  const listed = entries.map((entry) => ({
    value: entry.id,
    label: entry.installed ? entry.label : `${entry.label} (not installed)`,
    isDisabled: !entry.installed,
  }));
  if (chosenEditorId === null || entries.some((entry) => entry.id === chosenEditorId)) {
    return [SYSTEM_DEFAULT_OPTION, ...listed];
  }
  return [
    SYSTEM_DEFAULT_OPTION,
    ...listed,
    { value: chosenEditorId, label: "", isDisabled: true, isHidden: true },
  ];
}
