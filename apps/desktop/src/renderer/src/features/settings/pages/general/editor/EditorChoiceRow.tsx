// `Editor that opens files`: `System default`, then every editor the app looks for. One this
// machine lacks keeps its place, dimmed, cannot be picked and reads `(not installed)` after its
// name. A chosen editor this machine no longer has stays the row's value and draws the line that
// says files open in the system default, which is where main opens them.

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
import { PreferenceRow } from "#renderer/features/settings/components/PreferenceRow.js";
import type { MachineSettingsBinding } from "#renderer/features/settings/machine/hooks/useMachineSettings.js";
import { GENERAL_CONTROLS } from "../controls.js";
import { useEditorList } from "./hooks/useEditorList.js";

/** What the editor row is handed. */
export interface EditorChoiceRowProps {
  /** The bridge main's editor list is read through. */
  readonly bridge: PlatformBridge;
  /** The machine settings the choice reads and writes; the file has been read. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "settings" | "isPending" | "refusalFor" | "choose" | "retry"
  >;
  /** The window's clock, which the list's reads and the reading line's delay run on. */
  readonly clock: Clock;
}

/** The editor choice once main has listed the editors; before that, its reading or failed line. */
export function EditorChoiceRow(props: EditorChoiceRowProps): ReactNode {
  const { preferences } = props;
  const editors = useEditorList(props.bridge, props.clock);
  // A read's `Try again` can end in the same words; the press count says them again.
  const [readAgainCount, setReadAgainCount] = useState(0);
  const chosenEditorId = preferences.settings.editorId;
  const changedFromDefault =
    chosenEditorId === null
      ? undefined
      : { defaultDescription: `${SYSTEM_DEFAULT_OPTION.label} by default` };
  const writeRefusal = preferences.refusalFor("editorId");

  let row: ReactNode;
  let isChosenEditorMissing = false;
  if (editors.state.kind === "loaded") {
    const entries = editors.state.value;
    isChosenEditorMissing =
      chosenEditorId !== null &&
      !entries.some((entry) => entry.id === chosenEditorId && entry.installed);
    row = (
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
    );
  } else {
    const { state } = editors;
    row = (
      <>
        <PreferenceRow
          control={GENERAL_CONTROLS.editor}
          controlElementId={undefined}
          descriptionLines={[]}
          changedFromDefault={changedFromDefault}
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

  return (
    <>
      {row}
      {isChosenEditorMissing ? (
        <InlineRefusal
          code={EDITOR_NOT_FOUND_CODE}
          detail="That editor could not be found. Pick another, or files open in the system default."
          isStanding
        />
      ) : null}
      {writeRefusal === undefined ? null : (
        <InlineRefusal
          code={writeRefusal.code}
          detail={writeRefusal.detail}
          onTryAgain={() => {
            preferences.retry("editorId");
          }}
        />
      )}
    </>
  );
}

/** `System default`, the first entry and the value `null` stands for. */
const SYSTEM_DEFAULT_OPTION: PreferenceChoiceOption = { value: "", label: "System default" };

/** The code the line for a chosen editor this machine does not have is drawn under. */
const EDITOR_NOT_FOUND_CODE = "editor-not-found";

/**
 * `System default`, then each listed editor, one this machine lacks dimmed and unpickable. A
 * chosen id the list does not hold keeps its place as the value, last and unpickable.
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
    { value: chosenEditorId, label: `${chosenEditorId} (not installed)`, isDisabled: true },
  ];
}
