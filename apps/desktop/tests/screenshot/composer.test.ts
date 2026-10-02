// The screenshot tier: the composer feature's views, in both schemes. `settled-capture.ts` owns
// the mechanism.
//
// The composer's design claim is about addressing: a path label reading _new turn_ or _steer_ from
// the target run's subscribed state, never predicted, and a placeholder that names the target. A
// DOM assertion reading one attribute cannot hold that; an image can. The captures are the
// session's own composer (what focus outside the pane layout addresses), a working run (the
// new-turn path) and a run waiting on a person (the _steer_ address, where the composer scenario
// ends).

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
