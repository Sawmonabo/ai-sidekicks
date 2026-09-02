// The chords this window is holding for commands it cannot find.
//
// A block of the keyboard page and a module of its own, because the page had reached
// the length `apps/desktop/AGENTS.md` calls two jobs — and these rows genuinely are a
// second job: every other region on that page is about a command a person can run,
// and this one is about an id nothing on the page holds.
//
// WHY THESE ROWS EXIST AT ALL
//
// The override store admits a stored override whose command is unknown, deliberately:
// commands register at module scope as families load, and hydration runs when the
// frame attaches the store, so validating a hydrated key against the registry at that
// moment would silently delete a legitimate override for a family that had not
// registered yet. `composeEffectiveBindings` then appends the unknown command's
// binding, which is what makes a command shipping with no chord bindable — so the
// stale entry reserves its chord while the table above, built from the registered
// commands, cannot show it. Invisible, unresettable, and able to refuse somebody
// else's rebinding by naming an id they cannot find. The answer is to draw it.
//
// The block is ABSENT when there are none rather than rendering a count of zero: a
// region explaining a failure nobody has is a failure a person then goes looking for.
// That decision is the page's, which renders this component only when the composed
// set is non-empty; `keybinding-map.ts` composes the set and this file renders it.

import type { ReactNode } from "react";

import { ChordHint, WireFigure } from "../../primitives/index.js";
import type { StaleKeybindingOverrideRow } from "./keybinding-map.js";

export interface StaleKeybindingOverridesProps {
  /** The stale entries, already composed. Never empty: the page draws nothing for none. */
  readonly rows: readonly StaleKeybindingOverrideRow[];
  /** Drop one entry's override, restoring the chord to whatever else may claim it. */
  readonly onRemove: (row: StaleKeybindingOverrideRow) => void;
}

export function StaleKeybindingOverrides(props: StaleKeybindingOverridesProps): ReactNode {
  return (
    <section
      className="meridian-settings-page__block"
      aria-label="Chords kept for commands this build does not have"
    >
      <h3 className="meridian-settings-page__block-title">
        Chords kept for commands this build does not have
      </h3>
      <div className="meridian-settings-page__prose">
        <p>
          A chord you change is kept under the command&rsquo;s own id, and these ids belong to no
          command this build offers &mdash; each one was removed or renamed after the chord was set.
          They still hold their chords, so assigning one of them to something else is refused until
          it is removed here.
        </p>
      </div>
      <ul className="meridian-keymap__stale">
        {props.rows.map((row) => (
          <li className="meridian-keymap__stale-row" key={row.commandId}>
            {/* The id verbatim in mono: it is a stored string this console did not
                compose, and it is the only thing that identifies the entry. */}
            <WireFigure value={row.commandId} />
            <ChordHint chord={row.chord} />
            <button
              type="button"
              className="meridian-keymap__reset"
              aria-label={`Remove the chord kept for ${row.commandId}`}
              onClick={() => {
                props.onRemove(row);
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
