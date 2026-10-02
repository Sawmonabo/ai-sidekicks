// The screenshot tier: the terminal pane over the terminal-lease scenario, which ends with the
// shell held, in both schemes. `settled-capture.ts` owns the mechanism.

import { mountTerminalPane } from "../helpers/feature-mounts/terminal.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the terminal pane", [
  { captureName: "terminal-pane-held-lease", mount: mountTerminalPane },
]);
