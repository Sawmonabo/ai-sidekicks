// One row of the discovery list: the name, what it does, and the state it is in.
// A provider row has no button: a disabled one would claim the act exists here, and this console
// never sends a provider command from the line. Only a console row carries a button.
// An entry the provider declared disabled is rendered disabled and never explained, because the
// entry has no reason member.

import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { isDeclaredUnavailable, type CommandListEntry } from "../entries.js";

/** The entry one row shows, with the handlers for selecting or running it. */
export interface CommandListRowProps {
  readonly entry: CommandListEntry;
  readonly rowElementId: string;
  readonly isActive: boolean;
  readonly onSelect: () => void;
  readonly onRun: (commandId: string) => void;
}

/** Shown only on an entry the provider declared disabled. */
const UNAVAILABLE_LABEL = "unavailable — the provider published this entry as disabled";

/** One entry of the discovery list; only a console entry carries a Run button. */
export function CommandListRow(props: CommandListRowProps): React.JSX.Element {
  const { entry, rowElementId, isActive, onSelect, onRun } = props;
  const isUnavailable = isDeclaredUnavailable(entry);
  return (
    <li
      className={rowClassName(isActive, isUnavailable)}
      id={rowElementId}
      role="option"
      aria-selected={isActive}
      // Present only where declared: `false` on every other row would be a state the reply never
      // reported. The row stays reachable by the arrows either way.
      aria-disabled={isUnavailable ? true : undefined}
      onMouseDown={onSelect}
    >
      <span className="meridian-command-discovery__name">
        <WireFigure value={entry.name} />
      </span>
      {entry.source === "provider" ? (
        <span className="meridian-command-discovery__binding">
          {codeWords(entry.kind)} · {PROVIDER_LABELS[entry.driverName]}
        </span>
      ) : null}
      {isUnavailable ? (
        <span className="meridian-command-discovery__unavailable">{UNAVAILABLE_LABEL}</span>
      ) : null}
      {entry.description === undefined ? (
        // `empty`, not `not-checked`: the enumeration was read and this entry came back without
        // a description.
        <Nothing
          kind="empty"
          placement="inline"
          title="The provider published no description"
          detail="This entry was enumerated without one."
        />
      ) : (
        <span className="meridian-command-discovery__description">{entry.description}</span>
      )}
      {entry.source === "console" ? (
        <button
          type="button"
          className="meridian-command-discovery__run"
          onClick={() => {
            onRun(entry.commandId);
          }}
        >
          Run this
        </button>
      ) : null}
    </li>
  );
}

function rowClassName(isActive: boolean, isUnavailable: boolean): string {
  const classes = ["meridian-command-discovery__row"];
  if (isActive) {
    classes.push("meridian-command-discovery__row--active");
  }
  if (isUnavailable) {
    classes.push("meridian-command-discovery__row--unavailable");
  }
  return classes.join(" ");
}
