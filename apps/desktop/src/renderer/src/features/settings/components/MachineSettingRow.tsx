// One control kept in the machine's settings file, drawn from the first frame. Until the file has
// been read the row stands with its label and its lines and, once the page's one loading delay has
// run out, `Loading…` in the control's place, so it never shows a value it does not hold and the
// page does not move when the read lands; a read that failed puts `Couldn't load settings` with
// `Try again` there instead. Once read, the caller draws the control's own row, and a refused
// write draws its strip under it with `Try again` sending the same change again.

import { useState, type ReactNode } from "react";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { MachineSettingsBinding } from "../machine/hooks/useMachineSettings.js";
import type { MachineSettingsMember } from "../machine/snapshot.js";
import type { SettingsControl } from "../types.js";
import { PreferenceRow } from "./PreferenceRow.js";

/** Props for {@link MachineSettingRow}. */
export interface MachineSettingRowProps {
  /** The window's machine settings, which say whether the file has been read. */
  readonly preferences: Pick<
    MachineSettingsBinding,
    "snapshot" | "refusalFor" | "retry" | "readAgain"
  >;
  /** The member the control writes, whose refused write the row draws. */
  readonly member: MachineSettingsMember;
  /** The findable control the row draws, whose label stands while the file is unread. */
  readonly control: SettingsControl;
  /** The lines under the label while the file is unread, as the control's own row draws them. */
  readonly descriptionLines: readonly ReactNode[];
  /** Whether the page's one loading delay has run out, so the unread row reads `Loading…`. */
  readonly isPastLoadingDelay: boolean;
  /** Draws the control's own row, once the file has been read. */
  readonly renderControlRow: () => ReactNode;
}

/**
 * A settings-file control's row: its loading or failed line until the file is read, then the
 * control's own row.
 */
export function MachineSettingRow(props: MachineSettingRowProps): React.JSX.Element {
  const { preferences, member } = props;
  // A read's `Try again` clears the refusal and reopens in one act, so a reopen that fails at once
  // leaves the same line drawn; the press count says it again.
  const [readAgainCount, setReadAgainCount] = useState(0);
  const { reading, readRefusal } = preferences.snapshot;
  if (reading === undefined) {
    return (
      <PreferenceRow
        control={props.control}
        controlElementId={undefined}
        descriptionLines={props.descriptionLines}
        changedFromDefault={undefined}
        renderControl={() =>
          readRefusal === undefined ? (
            <LoadingNotice
              isPastDelay={props.isPastLoadingDelay}
              placement="inline"
              title="Loading…"
            />
          ) : (
            <InlineRefusal
              code={readRefusal.code}
              detail="Couldn't load settings"
              onTryAgain={() => {
                setReadAgainCount((count) => count + 1);
                preferences.readAgain();
              }}
              attempt={readAgainCount}
            />
          )
        }
      />
    );
  }
  const writeRefusal = preferences.refusalFor(member);
  return (
    <>
      {props.renderControlRow()}
      {writeRefusal === undefined ? null : (
        <InlineRefusal
          code={writeRefusal.code}
          detail={writeRefusal.detail}
          onTryAgain={() => {
            preferences.retry(member);
          }}
        />
      )}
    </>
  );
}
