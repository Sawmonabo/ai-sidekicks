// One row of the discovery list: the name, the origin mark on a provider's or a skill's row, what
// it does, and the state it is in. The row is its own control: a press on it does what Enter does
// on the active row, and nothing pressable sits inside it, since an option may hold no control. An
// entry that cannot act is drawn disabled and ignores a press: one the provider declared disabled
// is never explained, since it has no reason member; a skill that failed to load reads the
// daemon's reason.

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useProviderName } from "#renderer/store/providers/hooks/useProviderName.js";
import {
  isDeclaredUnavailable,
  type CommandListEntry,
  type SkillCommandEntry,
} from "../entries.js";

/** The entry one row shows, with the handlers for selecting it and acting on it. */
export interface CommandListRowProps {
  readonly entry: CommandListEntry;
  readonly rowElementId: string;
  readonly isActive: boolean;
  readonly onSelect: () => void;
  /** A press on the row: what Enter does on the active row. */
  readonly onActivate: () => void;
}

/** Shown only on an entry the provider declared disabled. */
const UNAVAILABLE_LABEL = "unavailable — the provider published this entry as disabled";

/** One entry of the discovery list, pressed as a whole. */
export function CommandListRow(props: CommandListRowProps): React.JSX.Element {
  const { entry, rowElementId, isActive, onSelect, onActivate } = props;
  const isUnavailable = isDeclaredUnavailable(entry);
  return (
    <li
      className={rowClassName(isActive, isUnavailable)}
      id={rowElementId}
      role="option"
      aria-selected={isActive}
      // Present only where declared: `false` on every other row would be a state the reply never
      // reported.
      aria-disabled={isUnavailable ? true : undefined}
      onMouseDown={isUnavailable ? undefined : onSelect}
      onClick={isUnavailable ? undefined : onActivate}
    >
      <span className="meridian-command-discovery__name">
        <WireFigure value={entry.name} />
      </span>
      {entry.source === "provider" ? <ProviderOrigin providerName={entry.providerName} /> : null}
      {entry.source === "skill" ? <SkillOrigin entry={entry} /> : null}
      {isUnavailable ? (
        <span className="meridian-command-discovery__unavailable">
          {entry.source === "skill" ? entry.loadError : UNAVAILABLE_LABEL}
        </span>
      ) : null}
      <EntryDescription entry={entry} />
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

function ProviderOrigin(props: { readonly providerName: ProviderId }): React.JSX.Element {
  return (
    <span className="meridian-command-discovery__origin">
      {useProviderName(props.providerName)}
    </span>
  );
}

/** A skill's origin mark: where its folder came from, then its scope, or the plugin it ships in. */
function SkillOrigin(props: { readonly entry: SkillCommandEntry }): React.JSX.Element {
  const { entry } = props;
  return (
    <span className="meridian-command-discovery__origin">
      {entry.origin === "plugin" ? (
        `plugin · ${entry.pluginName ?? ""}`
      ) : (
        <>
          {entry.originProvider === undefined ? (
            SIDEKICKS_ORIGIN
          ) : (
            <ProviderOriginWord providerName={entry.originProvider} />
          )}
          {` · ${entry.scope}`}
        </>
      )}
    </span>
  );
}

/** The origin word of a skill made in this app. */
const SIDEKICKS_ORIGIN = "sidekicks";

/** A provider's name as an origin mark spells it, in lower case. */
function ProviderOriginWord(props: { readonly providerName: ProviderId }): React.JSX.Element {
  return <>{useProviderName(props.providerName).toLowerCase()}</>;
}

/** What an entry does, in its own words; a skill whose `SKILL.md` carries none shows nothing. */
function EntryDescription(props: { readonly entry: CommandListEntry }): React.JSX.Element | null {
  const { entry } = props;
  if (entry.description !== undefined) {
    return <span className="meridian-command-discovery__description">{entry.description}</span>;
  }
  if (entry.source === "skill") {
    return null;
  }
  // `empty`, not `not-checked`: the enumeration was read and this entry came back without a
  // description.
  return (
    <Nothing
      kind="empty"
      placement="inline"
      title="The provider published no description"
      detail="This entry was enumerated without one."
    />
  );
}
