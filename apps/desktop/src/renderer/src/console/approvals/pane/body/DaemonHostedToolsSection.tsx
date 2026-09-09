// The daemon-hosted tool section, present exactly where the capability is.
//
// Split out of `ApprovalsPaneBody.tsx`, and it owns its own `<section>` rather than
// being seated in one the pane wrote — which is the whole point. `CallbackTools`
// returns `null` for a driver that declares no `callback_tools`, because the feature
// is ABSENT rather than empty for that driver; a wrapper written outside it went on
// rendering the heading over nothing and reported a registry surface where the
// capability contract says none exists. The gate and the body it gates now live on one
// side of the boundary, so there is no arrangement of the two that renders a heading
// with nothing under it.
//
// A REFUSED CAPABILITY READ IS NOT AN ABSENCE, and it is answered before the flag is
// consulted at all. A refused readout declares nothing, so every flag on it reads
// `unknown` — and rendering that reading would say "the driver's flags have not been
// read" while throwing away the code and sentence the daemon gave for why. The section
// stays, and it carries the daemon's own words, in the shape the runs pane renders the
// same readout's refusal in: a line beside the surface the reading gates.

import { InlineRefusal } from "../../../primitives/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";
import { type DriverCapabilityReading } from "../../../bridge/index.js";
import { CallbackTools } from "../posture/CallbackTools.js";
import { type CallbackToolRegistryReading } from "../posture/callback-tool-registry.js";

export function DaemonHostedToolsSection(
  props: DaemonHostedToolsSectionProps,
): React.JSX.Element | null {
  // Absent, not empty — and only where the drivers actually answered. A refused read
  // declares nothing, so it must not be allowed to look like a declared absence.
  if (props.readRefusal === undefined && props.capability === "undeclared") {
    return null;
  }
  return (
    <section className="meridian-approvals__section" aria-label="Daemon-hosted tools">
      <h2 className="meridian-approvals__heading">Daemon-hosted tools</h2>
      {props.readRefusal === undefined ? (
        <CallbackTools capability={props.capability} registry={props.registry} />
      ) : (
        <InlineRefusal code={props.readRefusal.code} detail={props.readRefusal.detail} />
      )}
    </section>
  );
}

interface DaemonHostedToolsSectionProps {
  /**
   * The capability across every run this pane's decisions address.
   *
   * A session-level reading and not one run's: the pending decisions may name runs
   * bound to different drivers, and `readingAcrossRuns` folds the whole set.
   */
  readonly capability: DriverCapabilityReading;
  /** Why the declarations could not be read, where they could not be. */
  readonly readRefusal: ConsoleRefusal | undefined;
  /** What the registry read settled on, or `undefined` while it is in flight. */
  readonly registry: CallbackToolRegistryReading | undefined;
}
