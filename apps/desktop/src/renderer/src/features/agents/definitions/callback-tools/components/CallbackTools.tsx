// Which daemon-hosted tools an agent can reach. Two states never merge: registry withheld (the
// daemon's approval service is not running, or its tool route does not serve the tools to the
// provider, so a stray invocation is denied), and exposed. The registry is never synthesized from
// observed tool rows.

import "./CallbackTools.css";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { CallbackToolRows } from "./CallbackToolRows.js";
import { type CallbackToolRegistryReading } from "../registry.js";

/** What the daemon-hosted tools section renders from: the registry. */
export interface CallbackToolsProps {
  /**
   * What the registry read settled on, or `undefined` while in flight. A discriminated reading
   * rather than a list beside a flag, which would admit combinations that mean neither.
   */
  readonly registry: CallbackToolRegistryReading | undefined;
}

/** The daemon-hosted tools section: reading, withheld, or exposed, never merged. */
export function CallbackTools(props: CallbackToolsProps): React.JSX.Element {
  if (props.registry === undefined) {
    return <Nothing kind="not-loaded" placement="block" title="Loading the callback tools…" />;
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
