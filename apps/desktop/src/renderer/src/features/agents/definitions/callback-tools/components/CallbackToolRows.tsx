// One row per registered callback tool, with the input schema one click away. `CallbackTools.tsx`
// owns the withheld/exposed rule; this file only draws rows. The panel names a tool's arguments
// (read by `features/agents/definitions/callback-tools/arguments.ts`) and renders no values, so it
// stays a list of tools rather than a schema viewer.

import { useMemo } from "react";

import type { SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import { Collapsible } from "@base-ui/react/collapsible";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { callbackToolArguments, type CallbackToolArgument } from "../arguments.js";

/**
 * One row per entry, with the schema one click away. `deniedTone` presents the withheld arm
 * the caller already narrowed (registered but unreachable); it is not a second reachability
 * decision.
 */
export function CallbackToolRows(props: {
  readonly tools: readonly SessionCallbackTool[];
  readonly deniedTone?: boolean;
}): React.JSX.Element | null {
  const rows: readonly CallbackToolRow[] = useMemo(
    () =>
      props.tools.map((tool) => ({ tool, toolArguments: callbackToolArguments(tool.inputSchema) })),
    [props.tools],
  );
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-callback-tools__list">
      {rows.map((row) => (
        <li className="meridian-callback-tools__row" key={row.tool.name}>
          <div className="meridian-callback-tools__line">
            <WireFigure value={row.tool.name} />
            {props.deniedTone === true ? (
              <Chip label="denied" tone="failure" />
            ) : (
              <Chip label="background service" />
            )}
            <span className="meridian-callback-tools__description">{row.tool.description}</span>
          </div>
          <Collapsible.Root>
            <Collapsible.Trigger className="meridian-disclosure-trigger">
              Input schema
            </Collapsible.Trigger>
            <Collapsible.Panel>
              {row.toolArguments.length === 0 ? (
                // Said rather than left blank: an empty list reads as a panel that failed
                // to render.
                <p className="meridian-callback-tools__schema-empty">
                  This tool&apos;s registered schema names no arguments.
                </p>
              ) : (
                <ul className="meridian-callback-tools__schema-keys">
                  {row.toolArguments.map((argument) => (
                    <li key={argument.name}>
                      <WireFigure value={argument.name} />
                      {argument.isRequired ? (
                        // The console's own word, not a wire figure: it says what the
                        // schema's `required` list means.
                        <span className="meridian-callback-tools__schema-required">required</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Collapsible.Panel>
          </Collapsible.Root>
        </li>
      ))}
    </ul>
  );
}

/** One entry with its arguments already read, which is what a row renders from. */
interface CallbackToolRow {
  readonly tool: SessionCallbackTool;
  readonly toolArguments: readonly CallbackToolArgument[];
}
