// Which running animation could move a box, and which could not.
//
// `element-motion.ts` holds the DOM SEAMS — which events announce motion, which
// ancestors can move a subject — and `motion-sampling.ts` holds the frame loop those
// seams arm. This module holds the third question, and it is the one that decides
// whether the loop runs at all: given a running animation, could it move anything?
//
// IT EXISTS BECAUSE "SOMETHING IS ANIMATING" IS NOT THAT QUESTION. Every `not-loaded`
// skeleton runs an infinite opacity pulse (`primitives/primitives.css`), so a single
// loading surface anywhere on screen made the document-wide reading true forever: the
// frame sampler re-armed on every frame and ran a pane's geometry reads on every
// frame, for as long as anything was loading, over an animation that cannot move a
// box at all. A permanent RAF loop is exactly what the console's idle-CPU budget
// forbids, and nothing about it was visible — the pane's rectangle was simply
// recomputed forever and always came out the same.
//
// TWO BOUNDS, AND EACH ONE ALONE IS INSUFFICIENT: what a keyframe animates, and where
// the animated box sits. Both fail SAFE — an animation this module cannot read, and a
// box whose flow it cannot resolve, both count as able to move something, because
// "cannot tell" and "cannot move it" are different answers and only one of them is
// cheap to be wrong about.

/**
 * The properties whose animation moves NOTHING, spelled as one closed set.
 *
 * Written as the EXCLUDED set rather than as an allowlist of layout properties, and
 * the direction is the decision: a property this set does not name counts, so a
 * spelling nobody thought of costs one frame read, while an allowlist that forgot
 * `gap` or `flex-basis` would leave a native view at coordinates its pane had
 * abandoned for the whole of an animation — silent, and the exact class the position
 * observer exists to catch. Every entry is a paint-time property: it changes what a
 * box looks like and can change neither its size nor where it sits.
 *
 * Compared in a normalized form — lower-cased with the separators dropped — because
 * `getKeyframes()` answers in camel case (`backgroundColor`) while a stylesheet is
 * authored in kebab (`background-color`), and one set has to cover both spellings.
 */
const PAINT_ONLY_ANIMATED_PROPERTIES: ReadonlySet<string> = new Set(
  [
    "opacity",
    "color",
    "background",
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "border-color",
    "border-block-color",
    "border-inline-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "box-shadow",
    "text-shadow",
    "text-decoration-color",
    "column-rule-color",
    "caret-color",
    "accent-color",
    "filter",
    "backdrop-filter",
    "fill",
    "stroke",
    "visibility",
  ].map(normalizeAnimatedPropertyName),
);

/**
 * The keys `getKeyframes()` returns that are not properties at all.
 *
 * A keyframe carries its own timing beside the properties it sets, and counting
 * `easing` as an animated property would make every animation layout-affecting —
 * which is the undiscriminated reading this module replaces.
 */
const KEYFRAME_TIMING_KEYS: ReadonlySet<string> = new Set(
  ["offset", "computedOffset", "composite", "easing"].map(normalizeAnimatedPropertyName),
);

function normalizeAnimatedPropertyName(name: string): string {
  return name.toLowerCase().replaceAll("-", "");
}

/**
 * Whether this animation could move a box the caller cares about.
 *
 * The containment half is a PARAMETER rather than an element, because the vocabulary
 * for "this motion carries my subject" belongs to `element-motion.ts` and writing it
 * a second time here is how the two answers start to disagree. The caller says which
 * targets carry its subject; this module says whether the animation moves anything at
 * all, and whether a target that does NOT carry the subject can still displace it.
 */
export function couldAnimationMove(
  animation: Animation,
  carriesSubject: (target: Element) => boolean,
): boolean {
  if (!affectsLayoutOrPosition(animation)) {
    return false;
  }
  const target = animationTargetElement(animation);
  if (target === null) {
    return true;
  }
  return carriesSubject(target) || isInNormalFlow(target);
}

/**
 * Whether this animation touches anything that can change a box's size or place.
 *
 * The keyframes are the reading rather than the animation's name or its target's
 * class, because they are what the platform actually interpolates — and a CSS
 * transition, a CSS animation, and a scripted `element.animate()` all answer here in
 * the same vocabulary.
 */
function affectsLayoutOrPosition(animation: Animation): boolean {
  const keyframes = readKeyframes(animation);
  if (keyframes === undefined) {
    return true;
  }
  return keyframes.some((keyframe) =>
    Object.keys(keyframe).some((property) => {
      const normalized = normalizeAnimatedPropertyName(property);
      return (
        !KEYFRAME_TIMING_KEYS.has(normalized) && !PAINT_ONLY_ANIMATED_PROPERTIES.has(normalized)
      );
    }),
  );
}

/** The animation's keyframes, or `undefined` where this build cannot read them. */
function readKeyframes(animation: Animation): readonly Record<string, unknown>[] | undefined {
  const effect = readEffect(animation);
  const getKeyframes = effect?.getKeyframes;
  if (typeof getKeyframes !== "function") {
    return undefined;
  }
  try {
    return getKeyframes.call(effect) as readonly Record<string, unknown>[];
  } catch {
    // A build that answers the method and throws from it cannot tell us either, which
    // is the same answer as not having it.
    return undefined;
  }
}

/** The element an animation is running on, or `null` where it names none. */
function animationTargetElement(animation: Animation): Element | null {
  const target = readEffect(animation)?.target;
  return target instanceof Element ? target : null;
}

/** The effect, read structurally: `AnimationEffect` declares neither member. */
function readEffect(
  animation: Animation,
): { readonly getKeyframes?: unknown; readonly target?: unknown } | undefined {
  const effect: unknown = animation.effect;
  return effect === null || typeof effect !== "object" ? undefined : effect;
}

/**
 * Whether this box lays out among its siblings.
 *
 * An absolutely or fixed positioned box is out of its siblings' flow, so animating
 * its geometry cannot move an in-flow box beside it — which is what the overlays,
 * sheets, and toasts that animate most of the time are. The residual is stated rather
 * than hidden: an out-of-flow box can still change the document's scrollable overflow
 * and so whether a scrollbar is present, and that move is picked up by the class or
 * style write that caused it rather than here.
 *
 * Absent `getComputedStyle` — a shim, a detached document — the answer is yes, which
 * keeps the coarser reading rather than silently dropping motion.
 */
function isInNormalFlow(target: Element): boolean {
  if (typeof getComputedStyle !== "function") {
    return true;
  }
  const position = getComputedStyle(target).position;
  return position !== "absolute" && position !== "fixed";
}
