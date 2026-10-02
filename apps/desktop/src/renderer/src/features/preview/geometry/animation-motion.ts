// Whether a running animation could move a box. `element-motion.ts` holds the DOM seams and
// `motion-sampling.ts` the frame loop; this decides whether the loop runs at all.
//
// "Something is animating" is not enough: every `not-loaded` skeleton runs an infinite opacity
// pulse (`meridian-skeleton-pulse`, in `components/Nothing/Nothing.css`), which would keep the
// sampler re-arming every frame for as long as anything loads. Two bounds decide: what a
// keyframe animates, and where the animated box sits. Both fail safe: an animation or flow that
// cannot be read counts as able to move something.

/**
 * The properties whose animation moves nothing: paint-time properties that change neither a
 * box's size nor its place. An exclusion set rather than an allowlist of layout properties, so
 * a spelling nobody thought of costs one frame read, where a forgotten layout property would
 * leave a native view at abandoned coordinates.
 *
 * A tuple, not a `Set`, like `CLIPPING_OVERFLOW_VALUES` in `lib/clipping-ancestors.ts`: a
 * module-level collection stays mutable while `ReadonlySet` restricts only the binding.
 * Compared normalized (lower-cased, separators dropped) because `getKeyframes()` answers in
 * camel case while stylesheets are authored in kebab case.
 */
export const PAINT_ONLY_ANIMATED_PROPERTIES = [
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
] as const;

/**
 * The keys `getKeyframes()` returns that are timing, not properties; counting `easing` as an
 * animated property would make every animation layout-affecting. No `satisfies` mirror against
 * `keyof ComputedKeyframe`: that interface has a string index signature, so `keyof` widens to
 * `string | number` and the guard would assert nothing.
 */
export const KEYFRAME_TIMING_KEYS = ["offset", "computedOffset", "composite", "easing"] as const;

/** Lower-cases a property name and drops its dashes, so camel and kebab spellings compare equal. */
export function normalizeAnimatedPropertyName(name: string): string {
  return name.toLowerCase().replaceAll("-", "");
}

/**
 * Whether this animation could move a box the caller cares about. The caller supplies
 * `carriesSubject` because the vocabulary for "this motion carries my subject" belongs to
 * `element-motion.ts`; this decides whether the animation moves anything, and whether a target
 * that does not carry the subject can still displace it.
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

/** Whether a closed set of authored names holds this normalized property. */
function namesNormalizedProperty(
  authoredNames: readonly string[],
  normalizedProperty: string,
): boolean {
  return authoredNames.some(
    (authoredName) => normalizeAnimatedPropertyName(authoredName) === normalizedProperty,
  );
}

/** Whether the animation touches anything that can change a box's size or place. */
function affectsLayoutOrPosition(animation: Animation): boolean {
  const keyframes = readKeyframes(animation);
  if (keyframes === undefined) {
    return true;
  }
  return keyframes.some((keyframe) =>
    Object.keys(keyframe).some((property) => {
      const normalized = normalizeAnimatedPropertyName(property);
      return (
        !namesNormalizedProperty(KEYFRAME_TIMING_KEYS, normalized) &&
        !namesNormalizedProperty(PAINT_ONLY_ANIMATED_PROPERTIES, normalized)
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
  return getKeyframes.call(effect) as readonly Record<string, unknown>[];
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
 * Whether this box lays out among its siblings. An absolute or fixed box is out of flow, so
 * animating its geometry cannot move an in-flow neighbor. The residual: an out-of-flow box can
 * still change scrollable overflow and so scrollbar presence, which the class or style write
 * that caused it picks up. Without `getComputedStyle` (a shim, a detached document) the answer
 * is yes, keeping the coarser reading.
 */
function isInNormalFlow(target: Element): boolean {
  if (typeof getComputedStyle !== "function") {
    return true;
  }
  const position = getComputedStyle(target).position;
  return position !== "absolute" && position !== "fixed";
}
