// One row per registered callback tool, with the schema one click away and never
// expanded.
//
// ITS OWN MODULE BECAUSE A `.tsx` DECLARES ONE COMPONENT. `CallbackTools.tsx` owns
// the three-state rule — undeclared, withheld, exposed — and this file owns what a
// row looks like once that file has decided there are rows. Splitting keeps the rule
// readable without a list rendering in the middle of it, and keeps this file free of
// the rule: nothing here reads the capability flag or the registry's arms.
//
// THE SCHEMA IS COLLAPSED AND ITS KEYS ARE NAMES ONLY. A callback tool's input
// schema is daemon-constructed, so its shape is not a secret — but it is also not
// what a person opening this section came to read, and a dozen expanded schemas is a
// wall of JSON where a list of tools should be. The panel names the top-level keys
// and renders no value, which is the smallest thing that answers "what does it take"
// without becoming a schema viewer this surface has no business being.

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { Collapsible } from "@base-ui/react/collapsible";

import { Chip, WireFigure } from "../../../primitives/index.js";

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
  if (props.tools.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-callback-tools__list">
      {props.tools.map((tool) => (
        <li className="meridian-callback-tools__row" key={tool.name}>
          <div className="meridian-callback-tools__line">
            <WireFigure value={tool.name} />
            {props.deniedTone === true ? (
              <Chip label="denied" tone="failure" />
            ) : (
              <Chip label="daemon-hosted" />
            )}
            <span className="meridian-callback-tools__description">{tool.description}</span>
          </div>
          <Collapsible.Root className="meridian-callback-tools__schema">
            <Collapsible.Trigger className="meridian-callback-tools__schema-trigger">
              Input schema
            </Collapsible.Trigger>
            <Collapsible.Panel className="meridian-callback-tools__schema-panel">
              <ul className="meridian-callback-tools__schema-keys">
                {Object.keys(tool.inputSchema).map((key) => (
                  <li key={key}>
                    <WireFigure value={key} />
                  </li>
                ))}
              </ul>
            </Collapsible.Panel>
          </Collapsible.Root>
        </li>
      ))}
    </ul>
  );
}
