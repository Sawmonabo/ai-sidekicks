// The screenshot tier: the repos feature's two views, in both schemes. `settled-capture.ts` owns
// the mechanism.
//
// The two are different compositions, not states of one. The mount list with its degraded
// mounts: three mounts, two answering the failing health verdicts `unreachable` and
// `identity_mismatch`; a bad mount must read as bad at a glance and still offer what it can,
// which for the second verdict is the re-attach that recovers it. That is a claim about what is
// drawn, which an image holds. The diff pane over a parsed change set: the compared states in the
// header, the changed-file list and the rows with gutter marks, and the one place the intraline
// highlight is visible as a highlight.

import { mountDiffPane, mountMountList } from "../helpers/feature-mounts/repos.js";
import { definePinnedViewCaptures } from "./pinned-view-captures.js";

definePinnedViewCaptures("the mount list and diff pane", [
  { captureName: "repos-mount-list-degraded-mount", mount: mountMountList },
  { captureName: "repos-diff-pane", mount: mountDiffPane },
]);
