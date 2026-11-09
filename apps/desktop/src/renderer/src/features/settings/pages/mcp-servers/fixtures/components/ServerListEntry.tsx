import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatRelativeTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import type {
  McpOverrideOrigin,
  McpServerInventoryEntry,
} from "@ai-sidekicks/contracts/mcp/server";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import { toneForServerStatus } from "../status-tone.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { useProviderName } from "#renderer/store/providers/hooks/useProviderName.js";

// Where a server applies: the words the add form offers for each scope a person writes, and the
// provider's own word, as the wire sends it, for a connector's and an administrator's.
const WHERE_IT_APPLIES: Readonly<
  Record<Exclude<McpServerInventoryEntry["scope"], "plugin">, string>
> = {
  user: "All projects",
  project: "This project · in the repo",
  local: "This project · not in the repo",
  connector: "connector",
  managed: "managed",
};

/**
 * One server in the list, pressed to select it: its name, provider, where it applies and its
 * state word, with each project it is switched off in and the reading's age, and, for a copy a
 * project does not use, which one takes its place there, as the daemon served it.
 *
 * Two same-named servers in two places are two entries, told apart by their place words.
 */
export function ServerListEntry(props: {
  readonly entry: McpServerInventoryEntry;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
  /** The instant the reading's age is counted to, in epoch milliseconds. */
  readonly nowMilliseconds: number;
}): ReactNode {
  const { entry, isSelected, onSelect, nowMilliseconds } = props;
  const clockLocale = useClockLocale();
  const providerName = useProviderName(entry.provider);
  return (
    <li>
      <button
        type="button"
        className="meridian-mcp__entry"
        aria-current={isSelected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="meridian-mcp__entry-identity">
          <WireFigure value={entry.serverName} />
          <Chip label={providerName} />
          <Chip
            label={MCP_SERVER_STATUS_WORDS[entry.status]}
            tone={toneForServerStatus(entry.status)}
          />
          {entry.disabledIn?.map((origin) => (
            <span key={overrideOriginWords(origin)} className="meridian-settings-page__aside">
              Off in <WireFigure value={overrideOriginWords(origin)} />
            </span>
          ))}
          {entry.observedAt === undefined ? null : (
            <>
              <span className="meridian-settings-page__aside">· updated</span>
              <WireFigure
                value={formatRelativeTime(entry.observedAt, nowMilliseconds)}
                hoverLabel={formatZonedDateTime(entry.observedAt, clockLocale)}
              />
            </>
          )}
        </span>
        <span className="meridian-mcp__entry-place meridian-settings-page__aside">
          {entry.scope === "plugin" ? (
            <>
              From plugin <WireFigure value={entry.scopeRef} />
            </>
          ) : (
            WHERE_IT_APPLIES[entry.scope]
          )}
        </span>
        {entry.supersededIn?.map((origin) => (
          <span
            key={overrideOriginWords(origin)}
            className="meridian-mcp__entry-note meridian-settings-page__aside"
          >
            Not used in <WireFigure value={overrideOriginWords(origin)} />: its own{" "}
            <WireFigure value={entry.serverName} /> takes its place.
          </span>
        ))}
      </button>
    </li>
  );
}

// The layer whose own entry takes a server's place: its file's path, with the distribution it is
// in where it is in one, or the administrator's layer as the wire names it.
function overrideOriginWords(origin: McpOverrideOrigin): string {
  if ("managedLayer" in origin) {
    return origin.managedLayer;
  }
  return origin.place === undefined ? origin.path : `${origin.path} · ${origin.place.distro}`;
}
