// One row per registered callback tool, with the schema one click away and never
// expanded.
//
// ITS OWN MODULE BECAUSE A `.tsx` DECLARES ONE COMPONENT. `CallbackTools.tsx` owns
// the three-state rule — undeclared, withheld, exposed — and this file owns what a
// row looks like once that file has decided there are rows. Splitting keeps the rule
// readable without a list rendering in the middle of it, and keeps this file free of
// the rule: nothing here reads the capability flag or the registry's arms.
//
// THE SCHEMA IS COLLAPSED AND WHAT IT NAMES ARE ARGUMENTS. A callback tool's input
// schema is daemon-constructed, so its shape is not a secret — but it is also not
// what a person opening this section came to read, and a dozen expanded schemas is a
// wall of JSON where a list of tools should be. The panel names the tool's ARGUMENTS
// and renders no value, which is the smallest thing that answers "what does it take"
// without becoming a schema viewer this surface has no business being. Which names
// those are is `callback-tool-arguments.ts`'s reading and not this file's: the panel
// used to list the top-level keys, which for a JSON Schema are its keywords, so the
// one shipped entry named neither of the two arguments it actually takes.

import { useMemo } from "react";

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { Collapsible } from "@base-ui/react/collapsible";

import { Chip, WireFigure } from "../../../primitives/index.js";
import { callbackToolArguments, type CallbackToolArgument } from "./callback-tool-arguments.js";

/** One entry with its arguments already read, which is what a row renders from. */
interface CallbackToolRow {
  readonly tool: SessionCallbackTool;
  readonly toolArguments: readonly CallbackToolArgument[];
}

/**
 * One row per entry, with the schema one click away and never expanded.
 *
 * `deniedTone` is the withheld arm's: the entry is registered and unreachable, and
 * the chip says which answer a stray invocation gets. It is a presentation of the
 * arm the caller already narrowed, never a second decision about reachability.
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
              <Chip label="daemon-hosted" />
            )}
            <span className="meridian-callback-tools__description">{row.tool.description}</span>
          </div>
          <Collapsible.Root className="meridian-callback-tools__schema">
            <Collapsible.Trigger className="meridian-callback-tools__schema-trigger">
              Input schema
            </Collapsible.Trigger>
            <Collapsible.Panel className="meridian-callback-tools__schema-panel">
              {row.toolArguments.length === 0 ? (
                // Said rather than left blank. An empty list under this trigger reads
                // as a panel that failed to render, and the two are different facts.
                <p className="meridian-callback-tools__schema-empty">
                  This tool&apos;s registered schema names no arguments.
                </p>
              ) : (
                <ul className="meridian-callback-tools__schema-keys">
                  {row.toolArguments.map((argument) => (
                    <li key={argument.name}>
                      <WireFigure value={argument.name} />
                      {argument.isRequired ? (
                        // The console's own word about the schema, so it is not a
                        // wire figure: `required` is what the schema's `required`
                        // list MEANS, not a string the daemon sent.
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
