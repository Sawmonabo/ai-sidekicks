import type { ReactNode } from "react";

import { Chip, DerivedFigure, WireFigure, formatCount } from "../../../../primitives/index.js";
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
 * The two name groups render through a camelCase helper rather than a second
 * component, on the `primitives/Nothing.tsx` precedent: a `.tsx` module declares one
 * component, and a list body its only caller owns has no identity outside it.
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
          {config.args === undefined || config.args.length === 0 ? null : (
            <span className="meridian-settings-page__aside">
              with <DerivedFigure text={formatCount(config.args.length)} /> declared arguments
            </span>
          )}
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

/**
 * One group of names the daemon served in place of values.
 *
 * Absent and empty are the same fact here and render the same way — as nothing —
 * because both mean this binding declares none of that kind, and inventing a
 * distinction the wire does not draw would be a reading rather than a render.
 */
function renderNameList(caption: string, names: readonly string[] | undefined): ReactNode {
  if (names === undefined || names.length === 0) {
    return null;
  }
  return (
    <div className="meridian-mcp__names">
      <span className="meridian-settings-page__aside">{caption}</span>
      <ul className="meridian-mcp__name-list">
        {names.map((name) => (
          <li key={name}>
            <WireFigure value={name} />
          </li>
        ))}
      </ul>
    </div>
  );
}
