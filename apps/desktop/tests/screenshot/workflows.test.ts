// The screenshot tier: the workflows feature's three views, in both schemes.
// `settled-capture.ts` owns the mechanism. The feature ships one destination screen and two
// panes, each captured as it draws with no call to read a run or a definition: the
// destination's frame, the run pane addressed at a run, and the builder pane on a definition with
// its node-graph and drafts regions.

import {
  mountWorkflowBuilderPane,
  mountWorkflowRunPane,
  mountWorkflowsDestination,
} from "../helpers/feature-mounts/workflows.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the workflows views", [
  { captureName: "workflows-destination", mount: mountWorkflowsDestination },
  { captureName: "workflow-run", mount: mountWorkflowRunPane },
  { captureName: "workflow-builder-definition", mount: mountWorkflowBuilderPane },
]);
