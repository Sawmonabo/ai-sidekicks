// The keyboard page: every chord this window installs, what the service says about
// them, and the one place a person changes one.
//
// `Spec-023 §Console Design (Meridian)` §Keyboard: "One row per command with its
// chord, its command id, and the when-grammar expression that scopes it …
// Conflict detection against the same when-scope, naming the command that already
// holds the chord … Never writes a binding to a wire; the map is renderer-local."
//
// WHERE A REBINDING GOES
//
// The frame publishes the seam (`frame/keybinding-override-store.ts`): one store per
// window, holding the overrides a person authored composed onto the chords the
// console ships, read by the frame's key dispatch through the same accessor this
// page reads. So a chord recorded here IS the chord installed — no second table, no
// second listener, no window in which the page and the keyboard disagree. The
// override is kept through the console's own persistence chokepoint under its
// `keybinding` value class, in this window's profile; it reaches no wire.
//
// The recorder captures the next press on the control itself, and the console
// keyboard is SUSPENDED while it does — which is what makes `$mod+1` recordable at
// all, since the frame's table listens on the window in the capture phase and would
// otherwise navigate to Sessions instead of letting the chord be bound.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { ConsoleRefusal } from "../../core/index.js";
import { FRAME_KEY_BINDINGS, consoleCommands } from "../../frame/command-surface.js";
import { auditKeybindings } from "../../frame/keybinding-audit.js";
import {
  consoleKeybindingOverrides,
  useKeybindingSurface,
} from "../../frame/keybinding-override-store.js";
import { COMMAND_PALETTE_OPEN_CHORD } from "../../palette/index.js";
import {
  ChordHint,
  HOST_CHORD_PLATFORM,
  InlineRefusal,
  Nothing,
  formatChordForPlatform,
  formatCount,
  useAnnounce,
} from "../../primitives/index.js";
import { KeybindingRowBody } from "./KeybindingRowBody.js";
import { StaleKeybindingOverrides } from "./StaleKeybindingOverrides.js";
import {
  composeKeybindingRows,
  composeStaleOverrideRows,
  matchKeybindingRows,
  type AppliedChordRecording,
  type KeybindingRow,
  type StaleKeybindingOverrideRow,
} from "./keybinding-map.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";
import "./keyboard.css";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-keyboard";

/** The filter field's id, so its label points at it rather than wrapping it. */
const FILTER_FIELD_ID = "meridian-keyboard-filter";

/** What the last rebinding said, if it said anything. One act, one answer. */
interface KeyboardActReport {
  readonly commandId: string;
  readonly refusal: ConsoleRefusal;
}

export function KeyboardPage(): ReactNode {
  const [query, setQuery] = useState("");
  const [recordingCommandId, setRecordingCommandId] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<KeyboardActReport | undefined>(undefined);
  const announce = useAnnounce();

  // The effective table, and whether the console keyboard is suspended. Read
  // through the frame's one accessor, so this page cannot draw a keyboard that
  // differs from the one installed.
  const keybindingSurface = useKeybindingSurface(consoleKeybindingOverrides);

  // Commands are read on EVERY render pass, not once per visit. The registry is a
  // mutable object with no change signal of its own, and the frame registers this
  // window's commands from an effect — which React runs AFTER a child page's first
  // render. A memo keyed on nothing therefore kept the empty registry a window that
  // opened directly on this route had, and the page showed no rows until the person
  // left the section and came back. The frame bumps its own command revision the
  // moment it registers, and that re-renders this subtree; reading here rather than
  // remembering is what lets the page see it, and it adds no second subscription to
  // a registry that publishes none. The BINDINGS are live for their own reason:
  // those are what this page changes.
  const commands = consoleCommands.all();
  const rows = composeKeybindingRows({
    commands,
    bindings: keybindingSurface.bindings,
    overrides: consoleKeybindingOverrides.overrides,
  });
  const audit = useMemo(() => auditKeybindings(keybindingSurface.bindings), [keybindingSurface]);
  // The chords this window is holding for commands it cannot find. Composed from the
  // SHIPPED table rather than the effective one, which is that table with these very
  // entries already appended.
  const staleOverrideRows = composeStaleOverrideRows({
    commands,
    shippedBindings: FRAME_KEY_BINDINGS,
    overrides: consoleKeybindingOverrides.overrides,
  });
  const visibleRows = matchKeybindingRows(rows, query);
  const overriddenRowCount = rows.filter((row) => row.overridden).length;

  // A recorder still armed when the page goes away would leave the console keyboard
  // suspended for the life of the window.
  useEffect(() => () => consoleKeybindingOverrides.endRecording(), []);

  const stopRecording = useCallback(() => {
    consoleKeybindingOverrides.endRecording();
    setRecordingCommandId(undefined);
  }, []);

  const startRecording = useCallback((commandId: string) => {
    consoleKeybindingOverrides.beginRecording();
    setRecordingCommandId(commandId);
    setReport(undefined);
  }, []);

  const settleRecording = useCallback(
    async (row: KeybindingRow, recording: AppliedChordRecording): Promise<void> => {
      const result =
        recording.outcome === "cleared"
          ? await consoleKeybindingOverrides.unbind(row.commandId)
          : await consoleKeybindingOverrides.bind(row.commandId, recording.chord);
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
      const unsaved = await consoleKeybindingOverrides.reset(row.commandId);
      setReport(undefined);
      announce(
        unsaved === undefined
          ? `${row.title} is back to the chord the console ships.`
          : `${row.title} is back to the chord the console ships for this window only. ${unsaved.detail}`,
      );
    },
    [announce],
  );

  const removeStaleOverride = useCallback(
    async (staleRow: StaleKeybindingOverrideRow): Promise<void> => {
      const unsaved = await consoleKeybindingOverrides.reset(staleRow.commandId);
      setReport(undefined);
      announce(
        unsaved === undefined
          ? `The chord kept for ${staleRow.commandId} has been removed.`
          : `The chord kept for ${staleRow.commandId} has been removed for this window only. ${unsaved.detail}`,
      );
    },
    [announce],
  );

  const resetEveryRow = useCallback(async (): Promise<void> => {
    const unsaved = await consoleKeybindingOverrides.resetAll();
    setReport(undefined);
    announce(
      unsaved === undefined
        ? "Every chord is back to the one the console ships."
        : `Every chord is back to the one the console ships, for this window only. ${unsaved.detail}`,
    );
  }, [announce]);

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Every chord this window installs, the command it runs, and the scope it runs in. Chords you
        change are kept for this window's profile in the console's own store — the map travels
        nowhere, and no machine and no other person is told which keys you press.
      </p>

      <section className="meridian-settings-page__block" aria-label="Chords">
        <h3 className="meridian-settings-page__block-title">Chords</h3>
        <div className="meridian-keymap__filter">
          <label className="meridian-keymap__filter-label" htmlFor={FILTER_FIELD_ID}>
            Filter by command
          </label>
          <input
            id={FILTER_FIELD_ID}
            className="meridian-keymap__filter-input"
            type="text"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder="Go to settings"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {visibleRows.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title={
              rows.length === 0
                ? "This window has registered no commands."
                : `No command matches "${query.trim()}".`
            }
            detail={
              rows.length === 0
                ? "Commands are contributed by the surfaces that own them, and this window has none registered yet. A row appears here as soon as one does."
                : "The filter matches a command's name, its id, and its category. Clearing the field brings every command back."
            }
          />
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
                    if (recording.outcome !== "cancelled") {
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

      {/* Absent when there are none: a region explaining a failure nobody has is a
          failure a person then goes looking for. */}
      {staleOverrideRows.length === 0 ? null : (
        <StaleKeybindingOverrides
          rows={staleOverrideRows}
          onRemove={(staleRow) => {
            void removeStaleOverride(staleRow);
          }}
        />
      )}

      <section className="meridian-settings-page__block" aria-label="Changing a chord">
        <h3 className="meridian-settings-page__block-title">Changing a chord</h3>
        <div className="meridian-settings-page__prose">
          <p>
            Press <strong>Rebind</strong> on a row and then the chord you want. Escape leaves the
            chord alone, and Backspace or Delete leaves that command with no chord at all. The rest
            of the keyboard stops answering while a chord is being recorded, so a chord the console
            already uses can still be pressed. A chord another command answers to is refused on the
            row, naming the command that holds it; Reset puts a row back to the shipped chord.
          </p>
        </div>
        {overriddenRowCount === 0 ? (
          <Nothing
            kind="empty"
            placement="inline"
            title="Every chord is the one the console ships."
          />
        ) : (
          <button
            type="button"
            className="meridian-keymap__reset-all"
            onClick={() => {
              void resetEveryRow();
            }}
          >
            Reset all {formatCount(overriddenRowCount)} changed{" "}
            {overriddenRowCount === 1 ? "chord" : "chords"}
          </button>
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="What the keyboard reports">
        <h3 className="meridian-settings-page__block-title">What the keyboard reports</h3>
        {audit.conflicts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="inline"
            title="No two chords collide."
            detail="Every installed chord is the only one live in its scope, so each keystroke has exactly one answer."
          />
        ) : (
          <ul className="meridian-settings-page__list">
            {audit.conflicts.map((conflict) => (
              <li key={`${conflict.chord}:${conflict.commandIds.join("+")}`}>
                <InlineRefusal
                  code={conflict.reason}
                  detail={`${conflict.chord} is claimed by both ${conflict.commandIds[0]} and ${conflict.commandIds[1]}. ${conflict.detail}`}
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
                  code={dropped.commandId}
                  detail={`The chord ${dropped.chord} was not installed. ${dropped.reason}`}
                />
              </li>
            ))}
          </ul>
        )}
        {consoleKeybindingOverrides.hydrationRefusals.length === 0 ? null : (
          <ul className="meridian-settings-page__list">
            {consoleKeybindingOverrides.hydrationRefusals.map((declined) => (
              <li key={declined.commandId}>
                <InlineRefusal
                  code={declined.refusal.code}
                  detail={`A chord kept for ${declined.commandId} was not installed this time. ${declined.refusal.detail}`}
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
          <p>
            The application menu owns chords too, and they are not listed: the menu is built outside
            this window and nothing in here can read it. A chord the menu already holds will reach
            the menu and never the console, so the absence of a chord from this list is not a
            promise that it is free.
          </p>
        </div>
      </section>
    </div>
  );
}

/** What a settled rebinding says, and never more than it knows. */
function describeBinding(
  title: string,
  chord: string | null,
  unsaved: ConsoleRefusal | undefined,
): string {
  const act =
    chord === null
      ? `${title} now has no chord`
      : `${title} now runs on ${formatChordForPlatform(chord, HOST_CHORD_PLATFORM)}`;
  return unsaved === undefined
    ? `${act}, and the change is kept for this window.`
    : `${act} for as long as this window is open, and will not come back after a reload. ${unsaved.detail}`;
}

/** Claim the keyboard section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerKeyboardPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "keyboard",
    owner: OWNER,
    label: "Keyboard",
    keywords: [
      "shortcut",
      "chord",
      "hotkey",
      "binding",
      "keys",
      "palette",
      "accelerator",
      "rebind",
    ],
    render: () => <KeyboardPage />,
  });
}
