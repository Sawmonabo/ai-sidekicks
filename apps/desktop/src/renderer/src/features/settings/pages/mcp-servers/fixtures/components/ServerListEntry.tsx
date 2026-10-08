import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { PROVIDER_LABELS } from "@ai-sidekicks/contracts/provider/name";
import { formatRelativeTime, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import type {
  McpServerInventoryEntry,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import { MCP_SERVER_STATUS_WORDS } from "../../status-words.js";
import { toneForServerStatus } from "../status-tone.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";

// Where a binding a person writes applies, in the words the add form offers for each scope.
const WHERE_IT_APPLIES: Readonly<Record<McpWritableBindingRef["scope"], string>> = {
  user: "All projects",
  project: "This project · in the repo",
  local: "This project · not in the repo",
};

/**
 * One server in the list, pressed to select it: its name, provider, where it applies and its
 * state word with the reading's age, and, for a copy a project does not use, which one takes its
 * place there, as the daemon served it.
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
          <Chip label={PROVIDER_LABELS[entry.provider]} />
          <Chip
            label={MCP_SERVER_STATUS_WORDS[entry.status]}
            tone={toneForServerStatus(entry.status)}
          />
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
        {entry.supersededIn?.map((projectRoot) => (
          <span
            key={projectRoot}
            className="meridian-mcp__entry-note meridian-settings-page__aside"
          >
            Not used in <WireFigure value={projectRoot} />: its own{" "}
            <WireFigure value={entry.serverName} /> takes its place.
          </span>
        ))}
      </button>
    </li>
  );
}
