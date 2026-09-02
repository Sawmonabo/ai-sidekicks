// The keyboard page: every chord this window installs, and what the service says
// about them.
//
// `Spec-023 §Console Design (Meridian)` §Keyboard: "One row per command with its
// chord, its command id, and the when-grammar expression that scopes it …
// Conflict detection against the same when-scope, naming the command that already
// holds the chord … Never writes a binding to a wire; the map is renderer-local."
//
// WHAT THIS PAGE DOES NOT DRAW, AND WHY IT DRAWS NOTHING IN ITS PLACE
//
// The section also asks for a recorder and a reset. Both need somewhere to put an
// override, and this console has nowhere: the window installs exactly one
// `KeyBindingTable`, it is constructed inside the frame's command surface, and the
// settings context deliberately carries the bridge, the rail, and the open session
// and nothing else — no frame store, no table. A page that recorded a chord it
// could not install would be a control that leads nowhere, and one that installed
// its own second table would put two listeners on one keystroke and run half the
// console's commands twice. So the offer is absent with its reason, which is the
// console's rule for a capability it does not have, and the map is what this page
// is until the frame publishes a seam for one.
//
// The filter is a real control and does what it says: it narrows the rows in this
// renderer and writes nothing anywhere.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { COMMAND_PALETTE_OPEN_CHORD } from "../../palette/index.js";
import { ChordHint, InlineRefusal, Nothing, WireFigure } from "../../primitives/index.js";
import { FRAME_KEY_BINDINGS, consoleCommands } from "../../frame/command-surface.js";
import {
  auditKeybindings,
  composeKeybindingRows,
  matchKeybindingRows,
  type KeybindingRow,
} from "./keybinding-map.js";
import type { SettingsPageRegistry } from "../settings-page-registry.js";

/** The lane that owns this page, so an unfilled section names someone. */
const OWNER = "collaboration-settings-keyboard";

/** The filter field's id, so its label points at it rather than wrapping it. */
const FILTER_FIELD_ID = "meridian-keyboard-filter";

export function KeyboardPage(): ReactNode {
  const [query, setQuery] = useState("");

  // Read once per visit rather than per render. The command registry is a mutable
  // object with no change signal — the frame bumps a revision for the palette and
  // there is no such counter here — so the honest scope of this read is "the
  // commands this window had registered when the page opened", which is what
  // leaving the section and coming back re-reads.
  const keyboardMap = useMemo(
    () => ({
      rows: composeKeybindingRows({
        commands: consoleCommands.all(),
        bindings: FRAME_KEY_BINDINGS,
      }),
      audit: auditKeybindings(FRAME_KEY_BINDINGS),
    }),
    [],
  );
  const visibleRows = useMemo(
    () => matchKeybindingRows(keyboardMap.rows, query),
    [keyboardMap, query],
  );

  return (
    <div className="meridian-settings-page">
      <p className="meridian-settings-page__lede">
        Every chord this window installs, the command it runs, and the scope it runs in. The map
        lives in this renderer and travels nowhere — no machine and no other person is told which
        keys you press.
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
              keyboardMap.rows.length === 0
                ? "This window has registered no commands."
                : `No command matches "${query.trim()}".`
            }
            detail={
              keyboardMap.rows.length === 0
                ? "Commands are contributed by the surfaces that own them, and none of them had registered when this page opened."
                : "The filter matches a command's name, its id, and its category. Clearing the field brings every command back."
            }
          />
        ) : (
          <ul className="meridian-keymap">
            {visibleRows.map((row) => (
              <li key={row.commandId} className="meridian-keymap__row">
                <KeybindingRowBody row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="What the keyboard reports">
        <h3 className="meridian-settings-page__block-title">What the keyboard reports</h3>
        {keyboardMap.audit.conflicts.length === 0 ? (
          <Nothing
            kind="empty"
            placement="inline"
            title="No two chords collide."
            detail="Every installed chord is the only one live in its scope, so each keystroke has exactly one answer."
          />
        ) : (
          <ul className="meridian-settings-page__list">
            {keyboardMap.audit.conflicts.map((conflict) => (
              <li key={`${conflict.chord}:${conflict.commandIds.join("+")}`}>
                <InlineRefusal
                  code={conflict.reason}
                  detail={`${conflict.chord} is claimed by both ${conflict.commandIds[0]} and ${conflict.commandIds[1]}. ${conflict.detail}`}
                />
              </li>
            ))}
          </ul>
        )}
        {keyboardMap.audit.dropped.length === 0 ? null : (
          <ul className="meridian-settings-page__list">
            {keyboardMap.audit.dropped.map((dropped) => (
              <li key={`${dropped.chord}:${dropped.commandId}`}>
                <InlineRefusal
                  code={dropped.commandId}
                  detail={`The chord ${dropped.chord} was not installed. ${dropped.reason}`}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="meridian-settings-page__block" aria-label="Changing a chord">
        <h3 className="meridian-settings-page__block-title">Changing a chord</h3>
        <Nothing
          kind="not-checked"
          placement="surface"
          title="Chords cannot be changed here yet."
          detail="This window installs one keyboard table, built by the surface that owns the frame, and a settings page has no route to it. Recording a new chord here would record something nothing would ever install, so nothing is offered rather than a control that leads nowhere."
        />
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
            it has no row here.
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

/** One row: what runs, on what keys, in what scope. */
function KeybindingRowBody(props: { readonly row: KeybindingRow }): ReactNode {
  const { row } = props;
  return (
    <>
      <div className="meridian-keymap__head">
        <span className="meridian-keymap__title">{row.title}</span>
        {row.chord === undefined ? (
          <Nothing kind="empty" placement="inline" title="No chord" />
        ) : (
          <ChordHint chord={row.chord} />
        )}
      </div>
      <div className="meridian-keymap__meta">
        <WireFigure value={row.commandId} />
        <span className="meridian-keymap__scope">
          {row.whenExpression === undefined
            ? "Live everywhere in this window"
            : `Live when ${row.whenExpression}`}
        </span>
      </div>
      {row.unavailableReason === undefined ? null : (
        <p className="meridian-keymap__unavailable">{row.unavailableReason}</p>
      )}
    </>
  );
}

/** Claim the keyboard section. See `RuntimeNodesPage.tsx` on the seam's shape. */
export function registerKeyboardPage(registry: SettingsPageRegistry): void {
  registry.register({
    section: "keyboard",
    owner: OWNER,
    label: "Keyboard",
    keywords: ["shortcut", "chord", "hotkey", "binding", "keys", "palette", "accelerator"],
    render: () => <KeyboardPage />,
  });
}
