// Who a session event puts on the hue wheel, and on which step. Only agents wear a hue; the person
// and their devices carry none. An agent whose definition chose a step wears it, and every other
// agent takes the next unused step in the order agents joined, so every client draws the same hues
// whatever stretch of the log it holds. The events that brought each agent into the session reach
// every read among its standing events, so a read admits them before its rows, and the stream and
// pages admit the same agents from the same events.

import { isWireRecord } from "#renderer/lib/wire/record.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import type { AgentHueAllocator } from "#renderer/styles/agent-hue.js";
import { readHueWheelStep } from "#renderer/styles/tokens.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";
import { RUN_QUEUED_EVENT_KIND } from "./events/run/state-kinds.js";
import { SESSION_CREATED_EVENT_KIND } from "./standing-events.js";

/**
 * Admit to `allocator` the agent the event brings into the session, if any: the lead on
 * `session.created`, the agent a `run.queued` resolved from its definition, on the step that
 * definition chose where it chose one.
 */
export function admitToHueWheel(allocator: AgentHueAllocator, event: ProjectedSessionEvent): void {
  const kind = event.kind;
  const joiningAgent =
    kind === SESSION_CREATED_EVENT_KIND
      ? event.payload?.["mainAgent"]
      : kind === RUN_QUEUED_EVENT_KIND
        ? event.payload?.["resolvedAgent"]
        : undefined;
  if (!isWireRecord(joiningAgent)) {
    return;
  }
  const agentId = readWireString(joiningAgent["agentId"]);
  if (agentId === undefined) {
    return;
  }
  const resolvedConfiguration = joiningAgent["resolvedConfiguration"];
  const accentHue = isWireRecord(resolvedConfiguration)
    ? readWireString(resolvedConfiguration["accentHue"])
    : undefined;
  allocator.admit(agentId, accentHue === undefined ? undefined : readHueWheelStep(accentHue));
}
