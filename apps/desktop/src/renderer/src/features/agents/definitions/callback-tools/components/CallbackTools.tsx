// Which daemon-hosted tools an agent can reach. Three states never merge: capability undeclared
// (section absent), registry withheld (the daemon's approval service is not running or the
// provider cannot register the tools, so a stray invocation is denied), and exposed. The flag
// and the registry come from separate reads, so each has its own arm, and the registry is never
// synthesized from observed tool rows.

import "./CallbackTools.css";

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider/driver/capabilities";

import type { DriverCapabilityReading } from "#renderer/store/driver-capabilities/readings.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { CallbackToolRows } from "./CallbackToolRows.js";
import { type CallbackToolRegistryReading } from "../registry.js";

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
        title="The provider's support for tools the background service hosts has not been read."
        detail={
          "Nothing is listed until it has been read, because an empty list would read as if " +
          "the background service hosted none."
        }
      />
    );
  }
  if (props.registry === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="block"
        title="Reading the tools the background service hosts."
      />
    );
  }
  if (props.registry.kind === "withheld") {
    return (
      <div className="meridian-callback-tools">
        <p className="meridian-callback-tools__note">
          A sidekick cannot use these tools yet, and a call to one is denied.
        </p>
        <CallbackToolRows tools={props.registry.tools} deniedTone />
      </div>
    );
  }
  return (
    <div className="meridian-callback-tools">
      <p className="meridian-callback-tools__note">
        The background service hosts these tools, not a provider. A sidekick's call to one is an
        ordinary tool call under the permission level of the session or workflow run it works in, so
        a level that asks first raises the approval card before the tool runs.
      </p>
      <CallbackToolRows tools={props.registry.tools} />
    </div>
  );
}
