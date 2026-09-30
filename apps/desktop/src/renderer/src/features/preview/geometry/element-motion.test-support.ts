// Fakes for the motion sources: Web Animations readings and mutation-record settling. The size
// observer's fake is `tests/helpers/element-resize.ts`, beside the seam it drives.

/**
 * One animation whose play state the test moves, read live through the getter, so a case can
 * settle the motion between two sampler frames without handing over a different object.
 */
export function movingAnimation(): { readonly animation: Animation; settle: () => void } {
  let playState: AnimationPlayState = "running";
  return {
    animation: {
      get playState(): AnimationPlayState {
        return playState;
      },
    } as unknown as Animation,
    settle: () => {
      playState = "finished";
    },
  };
}

/**
 * One animation with the effect the motion filter reads: the properties its keyframes name and
 * the element it runs on.
 */
export function fakeAnimationOf(options: {
  readonly playState: AnimationPlayState;
  readonly properties: readonly string[];
  readonly target?: Element;
}): Animation {
  const keyframe: Record<string, unknown> = { offset: 0, easing: "linear", composite: "auto" };
  for (const property of options.properties) {
    keyframe[property] = "0";
  }
  return {
    playState: options.playState,
    effect: {
      target: options.target ?? null,
      getKeyframes: () => [keyframe],
    },
  } as unknown as Animation;
}

/** Gives one element a Web Animations reading, or takes the method away. */
export function withAnimations(
  element: Element,
  animations: readonly Animation[] | undefined,
): void {
  Object.defineProperty(element, "getAnimations", {
    configurable: true,
    value: animations === undefined ? undefined : () => [...animations],
  });
}

/**
 * Gives the document a Web Animations reading, which this test environment implements for no
 * node. Separate from `withAnimations` so a case can run an animation on the document while
 * every element reports none: a fixed-size sibling animating beside the subject.
 */
export function withDocumentAnimations(animations: readonly Animation[] | undefined): void {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: animations === undefined ? undefined : () => [...animations],
  });
}

/**
 * Lets queued `MutationObserver` records reach their callback. A task turn, not a microtask one:
 * measured, the DOM implementation these tiers run on delivers records on a queued task, and a
 * microtask-only wait reports zero deliveries. The trailing microtask lets whatever the callback
 * scheduled settle.
 */
export async function settleMutationRecords(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

const attachedRoots: Element[] = [];

/**
 * Holds a root in the live document until the case ends. Elements must really be attached,
 * because a transition on a detached ancestor bubbles to nothing, and a root left in the document
 * is an observer the next case's document-wide reading still finds.
 */
export function trackAttachedRoot<ElementType extends Element>(root: ElementType): ElementType {
  attachedRoots.push(root);
  return root;
}

/** Builds `ancestor > element`, both in the live document so events really bubble. */
export function attachedPair(): { readonly ancestor: HTMLElement; readonly element: HTMLElement } {
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  ancestor.append(element);
  document.body.append(ancestor);
  trackAttachedRoot(ancestor);
  return { ancestor, element };
}

/** Every suite's `afterEach` half, paired with `vi.unstubAllGlobals()` at the call site. */
export function detachAttachedRoots(): void {
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
}
