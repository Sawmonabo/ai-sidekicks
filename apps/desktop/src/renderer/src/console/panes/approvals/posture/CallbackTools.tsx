// Which daemon-hosted tools an agent can reach, and the difference between "none
// registered" and "withheld".
//
// THIS SURFACE'S OWN THREE-STATE RULE, because no committed document states it —
// though it is `Spec-023 §Meridian, the design language` rule 8 read for this
// registry, since "A renderer that collapses two of these into one is wrong".
// Keeping the three apart is the whole job:
//
//   • **Capability undeclared** — the section is ABSENT, not empty. A driver that
//     does not declare `callback_tools` hosts no registry at all, and an empty list
//     under a heading would report a registry that exists and holds nothing.
//   • **Withheld** — the daemon has no registered approval-create seam, so spawn
//     withholds the registry, the tools are not exposed, and the host's runtime
//     backstop answers any stray invocation `denied` with a driver diagnostic. The
//     surface says "withheld". It never says "none registered", and it never
//     presents an empty agent capability.
//   • **Exposed** — entries, described as daemon-constructed and daemon-trusted
//     rather than provider output, each carrying the governance fact.
//
// TWO THINGS THIS COMPONENT WILL NOT DO. It never synthesises the registry from
// observed tool rows, which would report only tools that have already been called.
// And it never presents a callback tool as ungoverned or as a provider tool: every
// daemon-registered callback tool is Cedar-governed identically to a provider tool,
// its invocations land as tool-activity rows, and none of them bypasses the
// approval pipeline.

import { type DriverCapabilityFlag, type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { Collapsible } from "@base-ui/react/collapsible";

import { Chip, Nothing, WireFigure } from "../../../primitives/index.js";

/**
 * The flag this section is gated on, pinned to the registered union.
 *
 * Annotated rather than written as a bare literal so a rename in
 * `packages/contracts` is a compile error here instead of a section that silently
 * gates on a flag no driver declares.
 */
export const CALLBACK_TOOLS_CAPABILITY: DriverCapabilityFlag = "callback_tools";

/** What this build knows about the capability. `undefined` means nobody has asked. */
export type CallbackToolCapability = "declared" | "undeclared" | undefined;

export interface CallbackToolsProps {
  readonly capability: CallbackToolCapability;
  /**
   * Whether spawn withheld the registry.
   *
   * Separate from an empty `tools` list on purpose: withheld and empty are two of
   * the three facts the header refuses to collapse, and a component that inferred
   * one from the other could not tell them apart.
   */
  readonly isWithheld: boolean;
  readonly tools: readonly SessionCallbackTool[];
}

export function CallbackTools(props: CallbackToolsProps): React.JSX.Element | null {
  if (props.capability === "undeclared") {
    // Absent, not empty. Returning `null` is the rule rendered.
    return null;
  }
  if (props.capability === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The daemon-hosted tool registry has not been read."
        detail="No registry-read method exists in the wire contract: the registry travels on the driver-facing spawn parameter and is not a client read. Until one lands the console shows nothing here rather than a list it assembled from tools that happen to have been called."
      />
    );
  }
  if (props.isWithheld) {
    return (
      <div className="meridian-callback-tools meridian-callback-tools--withheld">
        <p className="meridian-callback-tools__note">
          The registry is withheld. Spawn does not expose these tools while the daemon has no
          registered approval-create seam, so an agent cannot reach them, and a stray invocation is
          answered <WireFigure value="denied" /> by the host&apos;s runtime backstop with a driver
          diagnostic beside it — never completed without a policy decision, and never left
          unanswered.
        </p>
        {props.tools.length === 0 ? null : (
          <ul className="meridian-callback-tools__list">
            {props.tools.map((tool) => (
              <li className="meridian-callback-tools__row" key={tool.name}>
                <WireFigure value={tool.name} />
                <Chip label="denied" tone="failure" />
                <span className="meridian-callback-tools__description">{tool.description}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="meridian-callback-tools">
      <p className="meridian-callback-tools__note">
        These are constructed and trusted by the daemon rather than produced by a provider. Each one
        is governed exactly as a provider tool is, its invocations land as ordinary tool rows, and
        none of them bypasses the approval pipeline.
      </p>
      <ul className="meridian-callback-tools__list">
        {props.tools.map((tool) => (
          <li className="meridian-callback-tools__row" key={tool.name}>
            <div className="meridian-callback-tools__line">
              <WireFigure value={tool.name} />
              <Chip label="daemon-hosted" />
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
    </div>
  );
}
