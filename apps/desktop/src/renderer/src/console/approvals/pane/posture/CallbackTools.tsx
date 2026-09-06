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
// TWO READINGS, NOT ONE. The capability flag and the registry are separate facts
// with separate readers: the flag says whether this driver hosts a registry at all
// and comes from `driver.listCapabilities`, while the entries and their exposure
// come from `callback-tool-registry.ts`. Either can be unknown without the other
// being, so each has its own arm here and neither stands in for the other — a
// component that read one flag and inferred both would report an unread driver as a
// registry that holds nothing.
//
// TWO THINGS THIS COMPONENT WILL NOT DO. It never synthesises the registry from
// observed tool rows, which would report only tools that have already been called.
// And it never presents a callback tool as ungoverned or as a provider tool: every
// daemon-registered callback tool is Cedar-governed identically to a provider tool,
// its invocations land as tool-activity rows, and none of them bypasses the
// approval pipeline.

import { type DriverCapabilityFlag, type SessionCallbackTool } from "@ai-sidekicks/contracts";
import { Collapsible } from "@base-ui/react/collapsible";

import type { DriverCapabilityReading } from "../../../bridge/index.js";
import { Chip, InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import { type CallbackToolRegistryReading } from "./callback-tool-registry.js";

/**
 * The flag this section is gated on, pinned to the registered union.
 *
 * Annotated rather than written as a bare literal so a rename in
 * `packages/contracts` is a compile error here instead of a section that silently
 * gates on a flag no driver declares.
 */
export const CALLBACK_TOOLS_CAPABILITY: DriverCapabilityFlag = "callback_tools";

export interface CallbackToolsProps {
  /**
   * What this build knows about the capability, in the console's one vocabulary.
   *
   * `unknown` and not `undefined`: the reading is the bridge family's closed set, so
   * this section and the two run surfaces that gate on a driver flag cannot answer
   * the same question in three different spellings.
   */
  readonly capability: DriverCapabilityReading;
  /**
   * What the registry read settled on, or `undefined` while it is still in flight.
   *
   * A discriminated reading rather than a `tools` list beside an `isWithheld` flag:
   * withheld and empty are two of the three facts the header refuses to collapse,
   * and a pair of independent props admits the two combinations that mean neither.
   * The read that produced it is `callback-tool-registry.ts`'s; this component is a
   * rendering of its arms and derives none of them.
   */
  readonly registry: CallbackToolRegistryReading | undefined;
}

export function CallbackTools(props: CallbackToolsProps): React.JSX.Element | null {
  if (props.capability === "undeclared") {
    // Absent, not empty. Returning `null` is the rule rendered.
    return null;
  }
  if (props.capability === "unknown") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="The bound driver's capability flags have not been read."
        detail="Whether this session's agents can reach a daemon-hosted tool at all is a flag on the driver, and this build has not read one. Nothing is reported here until it has, because an empty list under a heading would report a registry that exists and holds nothing."
      />
    );
  }
  if (props.registry === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="surface"
        title="Reading the daemon-hosted tool registry."
      />
    );
  }
  if (props.registry.kind === "unread") {
    return (
      <InlineRefusal code={props.registry.refusal.code} detail={props.registry.refusal.detail} />
    );
  }
  if (props.registry.kind === "withheld") {
    return (
      <div className="meridian-callback-tools meridian-callback-tools--withheld">
        <p className="meridian-callback-tools__note">
          The registry is withheld. Spawn does not expose these tools while the daemon has no
          registered approval-create seam, so an agent cannot reach them, and a stray invocation is
          answered <WireFigure value="denied" /> by the host&apos;s runtime backstop with a driver
          diagnostic beside it — never completed without a policy decision, and never left
          unanswered.
        </p>
        <ToolRows tools={props.registry.tools} deniedTone />
        {/* The read this surface put, named rather than implied. It says nothing
            about what the registry holds — the entries above are the ones the
            contract registers — only that no wire answered a question about them. */}
        <InlineRefusal
          code={props.registry.unreadRefusal.code}
          detail={props.registry.unreadRefusal.detail}
        />
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
      <ToolRows tools={props.registry.tools} />
    </div>
  );
}

/**
 * One row per entry, with the schema one click away and never expanded.
 *
 * `deniedTone` is the withheld arm's: the entry is registered and unreachable, and
 * the chip says which answer a stray invocation gets. It is a presentation of the
 * arm the caller already narrowed, never a second decision about reachability.
 */
function ToolRows(props: {
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
