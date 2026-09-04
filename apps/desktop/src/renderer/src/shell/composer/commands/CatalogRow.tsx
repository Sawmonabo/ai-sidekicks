// One row of the discovery list: the name, what it does, and the state it is in.
//
// Its own module because it is its own job — the popover decides WHAT is listed and
// answers the keys, and this decides how one entry reads — and because the two jobs
// in one file had grown past the length this package splits at.
//
// THE PROVIDER ROW'S ABSENCE OF A BUTTON IS THE RULE MADE VISIBLE. It is not a
// disabled control: a disabled button asserts the act exists here and is momentarily
// unavailable, and this console will not send a provider command from the line at
// all. The one row that carries a button is the console's own act.
//
// A DECLARED DISABLED ENTRY IS RENDERED DISABLED, AND THAT IS A DIFFERENT CLAIM.
// `ProviderCommandEntry.enabled` is returned precisely so a client can tell a
// disabled command from one that does not exist — the driver deliberately does not
// filter, because dropping the entry would stop the reply being the provider's
// enumeration as observed. A row that ignored the member would tell a person the
// entry is among what the provider offers with no unavailable state anywhere on it.
// So the row carries `aria-disabled`, wears the dimmed treatment, and says the state
// in its own secondary text.
//
// AND IT SAYS NOTHING ABOUT WHY. The registered entry is `{ name, kind, description,
// scope, enabled, binding }` — there is no reason member anywhere on it — so the row
// states what was declared and stops. A sentence explaining the cause would be one
// this console wrote about a decision the provider made.

import { Nothing, WireFigure } from "../../../console/primitives/index.js";
import { isDeclaredUnavailable, type CommandCatalogEntry } from "./provider-command-catalog.js";

export interface CatalogRowProps {
  readonly entry: CommandCatalogEntry;
  readonly rowElementId: string;
  readonly isActive: boolean;
  readonly onSelect: () => void;
  readonly onRun: (commandId: string) => void;
}

/** The declared state, in the row's own words. Rendered only where it was declared. */
const UNAVAILABLE_LABEL = "unavailable — the provider published this entry as disabled";

export function CatalogRow(props: CatalogRowProps): React.JSX.Element {
  const { entry, rowElementId, isActive, onSelect, onRun } = props;
  const isUnavailable = isDeclaredUnavailable(entry);
  return (
    <li
      className={rowClassName(isActive, isUnavailable)}
      id={rowElementId}
      role="option"
      aria-selected={isActive}
      // Present only where the provider declared it. `aria-disabled` on every row
      // with `false` on most of them would be a state the reply never reported, and
      // the row stays reachable by the arrows either way: a person has to be able to
      // read what the binding published before they can be told it is unavailable.
      aria-disabled={isUnavailable ? true : undefined}
      onMouseDown={onSelect}
    >
      <span className="meridian-command-discovery__name">
        <WireFigure value={entry.name} />
      </span>
      {entry.source === "provider" ? (
        <span className="meridian-command-discovery__binding">
          {entry.kind} · <WireFigure value={entry.driverName} />
        </span>
      ) : null}
      {isUnavailable ? (
        <span className="meridian-command-discovery__unavailable">{UNAVAILABLE_LABEL}</span>
      ) : null}
      {entry.description === undefined ? (
        // `empty` and not `not-checked`: the enumeration WAS read, and it came back
        // carrying this entry without a description. Saying nobody asked would be
        // false about a read that happened, and the entry is offered exactly as it
        // was enumerated — nothing here supplies copy the provider did not.
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

/** The row's classes, composed once rather than at three nested ternaries. */
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
