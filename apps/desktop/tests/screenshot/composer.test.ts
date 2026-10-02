// The screenshot tier: the composer feature's views, in both schemes. `settled-capture.ts` owns
// the mechanism.
//
// The captures: the composer addressed at the session (focus outside the pane layout), at a working
// run, and at a run waiting on a person (where the composer scenario ends). One Send button and no
// mode, so nothing about the target shows in the box in any of them.

import {
  mountComposerProviderBoundRunning,
  mountComposerProviderBoundWaiting,
  mountComposerSessionDefault,
} from "../helpers/feature-mounts/composer.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the composer views", [
  { captureName: "composer-session-default", mount: mountComposerSessionDefault },
  { captureName: "composer-provider-bound-running", mount: mountComposerProviderBoundRunning },
  { captureName: "composer-provider-bound-waiting", mount: mountComposerProviderBoundWaiting },
]);
