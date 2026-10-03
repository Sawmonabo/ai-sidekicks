// The screenshot tier for the agents pane, in both schemes. It is a picture rather than an
// assertion because how the cards read together under the tool-allowlist line is a layout claim
// a DOM assertion cannot see. `settled-capture.ts` owns the mechanism.

import { mountAgentsPane } from "./agent-mounts.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the agents pane", [
  { captureName: "agents-pane", mount: mountAgentsPane },
]);
