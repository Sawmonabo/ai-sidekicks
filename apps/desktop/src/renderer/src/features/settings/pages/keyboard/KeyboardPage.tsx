// The keyboard page: every chord this window installs, what the service says about them, and
// the one place a person changes one.
//
// One row per command with its name and chord; conflict detection names the command that holds
// a chord, by its name. The map is renderer-local and never written to
// a wire. The page reads and writes the override store (`registries/keybindings/`), the same
// accessor the frame's key dispatch reads, so a recorded chord is the installed chord. Overrides
// live in main's keyboard map, one file on this machine; a map main could not use is read as
// the shipped chords and written out again, and the page says so. The recorder suspends the
// app keyboard, since the frame's capture-phase table would otherwise navigate on `$mod+1`.

import "./keyboard.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { Refusal } from "#renderer/lib/refusal/refusal.js";
import { auditKeybindings } from "#renderer/registries/keybindings/keybinding-audit.js";
import { commandRegistry } from "#renderer/registries/commands/window-command-registry.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/keybinding-override-store.js";
import { useKeybindingSnapshot } from "#renderer/registries/keybindings/hooks/useKeybindingSnapshot.js";
import {
  COMMAND_PALETTE_OPEN_CHORD,
  HOST_CHORD_PLATFORM,
  formatChordForPlatform,
} from "#renderer/lib/chord-format.js";
import { ChordHint } from "#renderer/components/ChordHint/ChordHint.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { KeybindingRowBody } from "./components/KeybindingRowBody.js";
import { ResetAllKeybindings } from "./components/ResetAllKeybindings.js";
import {
  composeKeybindingRows,
  matchKeybindingRows,
  type AppliedChordRecording,
  type KeybindingRow,
} from "./keybinding-map.js";

/** The filter field's id, so its label points at it rather than wrapping it. */
const FILTER_FIELD_ID = "meridian-keyboard-filter";

/** The code a chord the table could not install is drawn under. */
const CHORD_NOT_INSTALLED_CODE = "keybinding-not-installed";

/** The keyboard settings page: the chord map, the rebinding recorder, and the audit. */
export function KeyboardPage(): ReactNode {
  const [query, setQuery] = useState("");
  const [recordingCommandId, setRecordingCommandId] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<KeyboardActReport | undefined>(undefined);
  const announce = useAnnounce();

  // The effective table and whether the app keyboard is suspended, read through the same
  // accessor as the frame so the page cannot draw a different keyboard.
  const keybindingSnapshot = useKeybindingSnapshot(keybindingOverrides);

  // Read on every render, not once per visit: the registry has no change signal, and the frame
  // registers this window's commands from an effect that runs after this page's first render, so
  // a memo would keep the empty registry and show no rows. The frame bumps its command revision
  // on registering, which re-renders this subtree. Bindings are live because this page
  // changes them.
  const commands = commandRegistry.all();
  const rows = composeKeybindingRows({
    commands,
    bindings: keybindingSnapshot.bindings,
    // The shipped table, so each row can name the chord its reset restores; the effective
    // table already has the overrides composed onto it.
    shippedBindings: keybindingSnapshot.shippedBindings,
    overrides: keybindingOverrides.overrides,
  });
  const audit = useMemo(() => auditKeybindings(keybindingSnapshot.bindings), [keybindingSnapshot]);
  const visibleRows = matchKeybindingRows(rows, query);
  const changedRows = rows.filter((row) => row.overridden);
  // What a person reads for a command: its name, never its id.
  const titleOf = (commandId: string): string =>
    rows.find((row) => row.commandId === commandId)?.title ?? "another command";

  // A recorder still armed when the page goes away would leave the app keyboard suspended.
  useEffect(() => () => keybindingOverrides.endRecording(), []);

  const stopRecording = useCallback(() => {
    keybindingOverrides.endRecording();
    setRecordingCommandId(undefined);
  }, []);

  const startRecording = useCallback((commandId: string) => {
    keybindingOverrides.beginRecording();
    setRecordingCommandId(commandId);
    setReport(undefined);
  }, []);

  const settleRecording = useCallback(
    async (row: KeybindingRow, recording: AppliedChordRecording): Promise<void> => {
      const result =
        recording.outcome === "cleared"
          ? await keybindingOverrides.unbind(row.commandId)
          : await keybindingOverrides.bind(row.commandId, recording.chord);
      if (result.outcome === "refused") {
        setReport({ commandId: row.commandId, refusal: result.refusal });
        announce(`${row.title} kept its chord. ${result.refusal.detail}`);
        return;
      }
      setReport(undefined);
      announce(describeBinding(row.title, result.chord, result.unsaved));
    },
    [announce],
  );

  const resetRow = useCallback(
    async (row: KeybindingRow): Promise<void> => {
      const unsaved = await keybindingOverrides.reset(row.commandId);
      setReport(undefined);
      announce(
        unsaved === undefined
          ? `${row.title} is back to the chord the app ships.`
          : `${row.title} is back to the chord the app ships for this window ` +
              `only. ${unsaved.detail}`,
      );
    },
    [announce],
  );

  const resetEveryRow = useCallback(async (): Promise<void> => {
    const unsaved = await keybindingOverrides.resetAll();
    setReport(undefined);
    announce(
      unsaved === undefined
        ? "Every chord is back to the one the app ships."
        : `Every chord is back to the one the app ships, for this window only. ${unsaved.detail}`,
    );
  }, [announce]);

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Every key the app answers to. Change any of them.
      </p>

      <section className="meridian-settings-page__block" aria-label="Chords">
        <h3 className="meridian-settings-page__block-title">Chords</h3>
        <div className="meridian-keymap__filter">
          <label className="meridian-keymap__filter-label" htmlFor={FILTER_FIELD_ID}>
            Search shortcuts
          </label>
          <input
            id={FILTER_FIELD_ID}
            className="meridian-keymap__filter-input"
            type="text"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Search shortcuts"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {rows.length > 0 && visibleRows.length === 0 ? (
          <Nothing kind="empty" placement="block" title="No shortcut matches that." />
        ) : (
          <ul className="meridian-keymap">
            {visibleRows.map((row) => (
              <li key={row.commandId} className="meridian-keymap__row">
                <KeybindingRowBody
                  row={row}
                  recording={recordingCommandId === row.commandId}
                  refusal={report?.commandId === row.commandId ? report.refusal : undefined}
                  onStartRecording={() => {
                    startRecording(row.commandId);
                  }}
                  onRecorded={(recording) => {
                    stopRecording();
                    if (recording.outcome !== "canceled") {
                      void settleRecording(row, recording);
                    }
                  }}
                  onReset={() => {
                    void resetRow(row);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="Changing a chord">
        <h3 className="meridian-settings-page__block-title">Changing a chord</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Press <strong>Rebind</strong> on a row and then the chord you want. Escape leaves the
            chord alone, and Backspace or Delete leaves that command with no chord at all. The rest
            of the keyboard stops answering while a chord is being recorded, so a chord the app
            already uses can still be pressed. A chord another command answers to is refused on the
            row, naming the command that holds it; Reset puts a row back to the shipped chord.
          </p>
        </div>
        <ResetAllKeybindings
          changedRows={changedRows}
          onResetAll={() => {
            void resetEveryRow();
          }}
        />
      </section>

      <section className="meridian-settings-page__block" aria-label="What the keyboard reports">
        <h3 className="meridian-settings-page__block-title">What the keyboard reports</h3>
        {audit.conflicts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="inline"
            title="No two chords collide."
            detail={
              "Every installed chord is the only one live in its scope, so " +
              "each keystroke has exactly one answer."
            }
          />
        ) : (
          <ul className="meridian-settings-page__list">
            {audit.conflicts.map((conflict) => (
              <li key={`${conflict.chord}:${conflict.commandIds.join("+")}`}>
                <InlineRefusal
                  code={conflict.reason}
                  detail={
                    `${formatChordForPlatform(conflict.chord, HOST_CHORD_PLATFORM)} ` +
                    `is claimed by both ${titleOf(conflict.commandIds[0])} and ` +
                    `${titleOf(conflict.commandIds[1])}. ${conflict.detail}`
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {audit.dropped.length === 0 ? null : (
          <ul className="meridian-settings-page__list">
            {audit.dropped.map((dropped) => (
              <li key={`${dropped.chord}:${dropped.commandId}`}>
                <InlineRefusal
                  code={CHORD_NOT_INSTALLED_CODE}
                  detail={
                    `${titleOf(dropped.commandId)}'s chord ` +
                    `${formatChordForPlatform(dropped.chord, HOST_CHORD_PLATFORM)} ` +
                    `was not installed. ${dropped.reason}`
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {keybindingOverrides.repair === undefined ? null : (
          <p className="meridian-settings-page__state" role="alert">
            The keyboard map on this machine could not be read, so the chords the app ships with
            were used and the file was written out again. Any chord changed before now is back at
            the one the app ships with.
          </p>
        )}
        {keybindingOverrides.readRefusal === undefined ? null : (
          <InlineRefusal
            code={keybindingOverrides.readRefusal.code}
            detail={keybindingOverrides.readRefusal.detail}
          />
        )}
        {keybindingOverrides.hydrationRefusals.length === 0 ? null : (
          <ul className="meridian-settings-page__list">
            {keybindingOverrides.hydrationRefusals.map((declined) => (
              <li key={declined.commandId}>
                <InlineRefusal
                  code={declined.refusal.code}
                  detail={
                    `A chord kept for ${titleOf(declined.commandId)} was not ` +
                    `installed this time. ${declined.refusal.detail}`
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="meridian-settings-page__block"
        aria-label="Chords this list does not hold"
      >
        <h3 className="meridian-settings-page__block-title">Chords this list does not hold</h3>
        <div className="meridian-settings-page__prose">
          <p>
            The command palette opens on <ChordHint chord={COMMAND_PALETTE_OPEN_CHORD} />, which the
            palette installs for itself rather than through the table above — it runs no command, so
            it has no row here and cannot be changed. It stays live while a chord is being recorded
            too, which makes it the one chord a recorder here cannot receive.
          </p>
        </div>
      </section>
    </div>
  );
}

/** What the last rebinding said, if it said anything. One act, one answer. */
interface KeyboardActReport {
  readonly commandId: string;
  readonly refusal: Refusal;
}

/** What a settled rebinding says, and never more than it knows. */
function describeBinding(
  title: string,
  chord: string | null,
  unsaved: Refusal | undefined,
): string {
  const act =
    chord === null
      ? `${title} now has no chord`
      : `${title} now runs on ${formatChordForPlatform(chord, HOST_CHORD_PLATFORM)}`;
  return unsaved === undefined
    ? `${act}, and the change is kept on this machine.`
    : `${act} for as long as this window is open, and will not come ` +
        `back after a reload. ${unsaved.detail}`;
}
