import type { ReactNode } from "react";

import { Chip, WireFigure } from "../../../../primitives/index.js";
import type { GrowthMcpInventoryEntry } from "../../../../bridge/index.js";

/**
 * One binding's configuration, exactly as the daemon serves it back.
 *
 * THE READ-BACK IS THE REDACTED VIEW AND NOTHING ELSE. Configuration content splits
 * three ways on this surface: input a person types, whose credential-bearing values
 * are write-only in the renderer; the read-back, which is precisely this; and values
 * the daemon does not serve at all, which are rendered nowhere. This component is the
 * middle one, and it can only be the middle one — the wire carries `envVarNames`,
 * `headerNames`, and `urlQueryParamNames`, so a value is not withheld here, it never
 * arrived.
 *
 * THE URL IS QUERY-REDACTED AT THE DAEMON AND CARRIED VERBATIM FROM THERE. Trimming
 * it again here would be this console deciding which part of a served string is safe,
 * which is a judgment the producer already made — and a second, weaker copy of a
 * redaction rule is how the two stop agreeing.
 *
 * NAMES ARE RENDERED AS NAMES, never as a table with a blank value column. An empty
 * column reads as "the value is empty" rather than "there is no value here", which is
 * the confusion this whole split exists to remove.
 *
 * AND THE ARGUMENTS ARE RENDERED, NOT COUNTED. `--read-only` and `--allow-write` are
 * the same command and opposite grants, so a read-back that reported how MANY
 * arguments a binding declared told an operator that two bindings were identical when
 * one of them could write. They are strings the daemon already serves in the redacted
 * view — the same view the command itself arrives on — so rendering them withholds
 * nothing that was ever withheld, and the governing surface requires the command and
 * its arguments to stay inspectable.
 *
 * The three groups render through camelCase helpers rather than second components, on
 * the `primitives/Nothing.tsx` precedent: a `.tsx` module declares one component, and
 * a list body its only caller owns has no identity outside it.
 */
export function ConfigReadBack(props: {
  readonly config: GrowthMcpInventoryEntry["config"];
}): ReactNode {
  const { config } = props;
  return (
    <div className="meridian-mcp__config">
      <Chip label={config.transport} mono />
      {config.transport === "stdio" ? (
        <>
          <WireFigure value={config.command} />
          {renderArgumentList(config.args)}
          {renderNameList("Environment variables read", config.envVarNames)}
        </>
      ) : (
        <>
          <WireFigure value={config.url} />
          {renderNameList("Query parameters set", config.urlQueryParamNames)}
          {renderNameList("Headers sent", config.headerNames)}
          {config.bearerTokenEnvVar === undefined ? null : (
            <span className="meridian-settings-page__aside">
              Bearer token read from <WireFigure value={config.bearerTokenEnvVar} /> — the variable
              name, never its value.
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
 * One group of names the daemon served in place of values.
 *
 * A name group is a SET — which variables are read, which headers are sent — so the
 * name is its own identity and the order it arrives in carries nothing.
 */
function renderNameList(caption: string, names: readonly string[] | undefined): ReactNode {
  return renderWireStrings({
    caption,
    entries: names?.map((name) => ({ key: name, value: name })),
    positional: false,
  });
}

/**
 * The arguments the daemon served, in the order it served them.
 *
 * A POSITIONAL VECTOR RATHER THAN A SET, which is the whole difference from the
 * groups above: `--root /a --root /b` carries `--root` twice and means two roots, so
 * the position is the identity and the string is not, and reordering it would be this
 * console rewriting the command.
 */
function renderArgumentList(args: readonly string[] | undefined): ReactNode {
  return renderWireStrings({
    caption: "Arguments",
    entries: args?.map((argument, position) => ({ key: String(position), value: argument })),
    positional: true,
  });
}

/**
 * One bounded, wrapping list of wire strings under its caption.
 *
 * Absent and empty are the same fact here and render the same way — as nothing —
 * because both mean this binding declares none of that kind, and inventing a
 * distinction the wire does not draw would be a reading rather than a render.
 *
 * `positional` decides the element AND the class together because those are one fact:
 * an ordered list announces its members as a sequence, which is true of argv and false
 * of a name group, and each shape carries the enumeration bound its own class holds.
 */
function renderWireStrings(options: {
  readonly caption: string;
  readonly entries: readonly KeyedWireString[] | undefined;
  readonly positional: boolean;
}): ReactNode {
  const { caption, entries, positional } = options;
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
      {positional ? (
        <ol className="meridian-mcp__argument-list">{items}</ol>
      ) : (
        <ul className="meridian-mcp__name-list">{items}</ul>
      )}
    </div>
  );
}
