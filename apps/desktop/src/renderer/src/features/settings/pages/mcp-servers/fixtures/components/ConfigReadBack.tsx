import type { ReactNode } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useOverlayScrollbar } from "#renderer/hooks/useOverlayScrollbar.js";
import type { McpServerInventoryEntry } from "@ai-sidekicks/contracts/mcp/server";
import { SERVER_TRANSPORT_WORDS } from "../../transport-words.js";

/**
 * One binding's configuration, exactly as the daemon serves it back.
 *
 * This is the redacted view and nothing else: the wire carries `envVarNames`, `headerNames`
 * and `urlQueryParamNames`, so a value is not withheld here, it never arrived. The URL arrives
 * with its query and any user name or password stripped at the daemon and is rendered
 * verbatim, since a second redaction rule here would drift from the first. Names render as
 * names, not as a table with a blank value column, which would read as an empty value.
 * Arguments are rendered, not counted, because `--read-only` and `--allow-write` are the same
 * command with opposite grants.
 */
export function ConfigReadBack(props: {
  readonly config: McpServerInventoryEntry["config"];
}): ReactNode {
  const { config } = props;
  return (
    <div className="meridian-mcp__config">
      <Chip label={SERVER_TRANSPORT_WORDS[config.transport]} />
      {config.transport === "stdio" ? (
        <>
          <WireFigure value={config.command} />
          {renderArgumentList(config.args)}
          {renderNameList("Environment variables", config.envVarNames)}
        </>
      ) : (
        <>
          <WireFigure value={config.url} />
          {renderNameList("Address query", config.urlQueryParamNames)}
          {renderNameList("Headers", config.headerNames)}
          {config.bearerTokenEnvVar === undefined ? null : (
            <span className="meridian-settings-page__aside">
              Token from the environment variable <WireFigure value={config.bearerTokenEnvVar} />
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** One rendered wire string, and the identity the list around it keys it by. */
interface KeyedWireString {
  readonly key: string;
  readonly value: string;
}

/**
 * One group of names the daemon served in place of values. A set, so the name is its own
 * identity and arrival order carries nothing.
 */
function renderNameList(caption: string, names: readonly string[] | undefined): ReactNode {
  return (
    <WireStringGroup
      caption={caption}
      entries={names?.map((name) => ({ key: name, value: name }))}
      positional={false}
    />
  );
}

/**
 * The arguments the daemon served, in the order it served them.
 *
 * A positional vector, not a set: `--root /a --root /b` carries `--root` twice and means two
 * roots, so position is the identity and reordering would rewrite the command.
 */
function renderArgumentList(args: readonly string[] | undefined): ReactNode {
  return (
    <WireStringGroup
      caption="Arguments"
      entries={args?.map((argument, position) => ({ key: String(position), value: argument }))}
      positional
    />
  );
}

/**
 * One bounded, wrapping list of wire strings under its caption.
 *
 * Absent and empty both mean the binding declares none of that kind, so both render as
 * nothing. `positional` picks the element and class together: an ordered list announces a
 * sequence, true of argv and false of a name group.
 */
function WireStringGroup(props: {
  readonly caption: string;
  readonly entries: readonly KeyedWireString[] | undefined;
  readonly positional: boolean;
}): ReactNode {
  const { caption, entries, positional } = props;
  const scrollerRef = useOverlayScrollbar<HTMLDivElement>();
  if (entries === undefined || entries.length === 0) {
    return null;
  }
  const items = entries.map((entry) => (
    <li key={entry.key}>
      <WireFigure value={entry.value} />
    </li>
  ));
  return (
    <div className="meridian-mcp__names">
      <span className="meridian-settings-page__aside">{caption}</span>
      <div className="meridian-mcp__scroller" ref={scrollerRef}>
        {positional ? (
          <ol className="meridian-mcp__argument-list">{items}</ol>
        ) : (
          <ul className="meridian-mcp__name-list">{items}</ul>
        )}
      </div>
    </div>
  );
}
