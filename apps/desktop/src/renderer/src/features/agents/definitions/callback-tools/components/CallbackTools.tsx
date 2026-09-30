// Which daemon-hosted tools an agent can reach. Three states never merge: capability undeclared
// (section absent), registry withheld (no approval-create seam, so a stray invocation is
// denied), and exposed. The flag and the registry come from separate reads, so each has its
// own arm, and the registry is never synthesized from observed tool rows.

import "./CallbackTools.css";

import { type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { DriverCapabilityReading } from "@renderer/store/driver-capabilities/driver-capability-readings.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { CallbackToolRows } from "./CallbackToolRows.js";
import { type CallbackToolRegistryReading } from "../callback-tool-registry.js";

/**
 * The flag this section gates on. The annotation makes a contracts-side rename a compile
 * error rather than a section gated on a flag no driver declares.
 */
export const CALLBACK_TOOLS_CAPABILITY: DriverCapabilityFlag = "callback_tools";

/** What the daemon-hosted tools section renders from: the capability and the registry. */
export interface CallbackToolsProps {
  /**
   * What this build knows about the capability. `unknown` rather than `undefined`: the reading
   * is the bridge's closed set, so every gate on a driver flag answers in the same spelling.
   */
  readonly capability: DriverCapabilityReading;
  /**
   * What the registry read settled on, or `undefined` while in flight. A discriminated reading
   * rather than a list beside a flag, which would admit combinations that mean neither.
   */
  readonly registry: CallbackToolRegistryReading | undefined;
}

/** The daemon-hosted tools section: absent, withheld, or exposed, never merged. */
export function CallbackTools(props: CallbackToolsProps): React.JSX.Element | null {
  if (props.capability === "undeclared") {
    // Absent rather than empty.
    return null;
  }
  if (props.capability === "unknown") {
    return (
      <Nothing
        kind="not-checked"
        placement="block"
        title="The bound driver's capability flags have not been read."
        detail="Whether this session's agents can reach a tool the background service hosts at all is a flag on the driver, and this build has not read one. Nothing is reported here until it has, because an empty list under a heading would report a registry that exists and holds nothing."
      />
    );
  }
  if (props.registry === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="block"
        title="Reading the registry of tools the background service hosts."
      />
    );
  }
  if (props.registry.kind === "withheld") {
    return (
      <div className="meridian-callback-tools meridian-callback-tools--withheld">
        <p className="meridian-callback-tools__note">
          The registry is withheld. Spawn does not expose these tools while the background service
          has no registered approval-create seam, so an agent cannot reach them, and a stray
          invocation is answered <WireFigure value="denied" /> by the host&apos;s runtime backstop
          with a driver diagnostic beside it — never completed without a policy decision, and never
          left unanswered.
        </p>
        <CallbackToolRows tools={props.registry.tools} deniedTone />
      </div>
    );
  }
  return (
    <div className="meridian-callback-tools">
      <p className="meridian-callback-tools__note">
        These are constructed and trusted by the background service rather than produced by a
        provider. Each one is governed exactly as a provider tool is, its invocations land as
        ordinary tool rows, and none of them bypasses the approval pipeline.
      </p>
      <CallbackToolRows tools={props.registry.tools} />
    </div>
  );
}
