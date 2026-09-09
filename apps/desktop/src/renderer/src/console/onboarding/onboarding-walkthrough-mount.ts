// The one edge into the walkthrough's chunk, and the only one that is asynchronous.
//
// `onboarding-walkthrough-body.ts` is the chunk root and states why the walkthrough is
// off the initial import graph; this module is the half that stays ON it. It holds no
// step knowledge and imports the walkthrough only as a TYPE — that line is erased by
// the compiler, so the sole runtime edge into the chunk is the `import()` below.
//
// A `LoadedLazyBody` rather than a `lazy()` of this module's own, on
// `seats/schema-form/schema-form-mounts.ts`'s reasoning: that class is already the
// console's one answer to a loader-backed body, and a second normaliser beside it would
// be two settle semantics to keep in step.
//
// THE REMOUNT-PER-ACTIVATION KEY IS THE CALLER'S, and deliberately not this module's.
// `render` composes the descriptor every mount site reads and takes no key, so the
// overlay wraps the mount in a keyed fragment exactly as it keyed the element before —
// the step an activation opens at is that activation's, and a walkthrough that survived
// a second opening would ignore where it was asked to start.

import { LoadedLazyBody, reservedBodyRegion } from "../seats/index.js";
import type { OnboardingWalkthroughProps } from "./OnboardingWalkthrough.js";

/**
 * What a pending walkthrough stamps, so a refused capture says WHICH body was loading.
 *
 * Not a pane kind — this is a dialog's contents and the frame knows nothing about it —
 * so the value is the body's own name.
 */
const ONBOARDING_WALKTHROUGH_PENDING_BODY = "onboarding-walkthrough";

/** The walkthrough, mounted from its chunk. The overlay's one reader. */
export const onboardingWalkthroughMount: LoadedLazyBody<OnboardingWalkthroughProps> =
  new LoadedLazyBody(
    () => import("./onboarding-walkthrough-body.js"),
    () => reservedBodyRegion(ONBOARDING_WALKTHROUGH_PENDING_BODY),
  );
