// The screenshot tier: the preview pane chrome around an empty body, in both schemes.
// `settled-capture.ts` owns the mechanism.

import { mountPreviewPane } from "../helpers/feature-mounts/preview.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the preview pane", [
  { captureName: "preview-pane-chrome", mount: mountPreviewPane },
]);
