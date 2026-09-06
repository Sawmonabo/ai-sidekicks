// The Web Animations and mutation readings this family arms, under test control.
//
// The size observer is deliberately NOT here: it moved to
// `primitives/element-resize.test-support.ts` with the seam it drives, so the
// terminal family can reach it without importing across the DAG. What is left is
// browser-family work — the animation readings `element-motion.ts` takes and the
// mutation-record settling its ancestry watch needs.

/**
 * One animation in a fixed play state, as the Web Animations reading a seam takes.
 *
 * Only `playState` is read by anything in this family — the seams ask whether motion
 * is RUNNING and nothing else about it — so the fake carries that and says so, rather
 * than pretending to be an `Animation` a caller could drive.
 */
export function fakeAnimation(playState: AnimationPlayState): Animation {
  return { playState } as unknown as Animation;
}

/**
 * One animation whose play state the test moves, read live through the getter.
 *
 * The getter is what makes a frame loop testable: the sampler re-reads the state on
 * every frame, so a case that settles the motion between two frames has to be able to
 * change the answer without handing the sampler a different object.
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
 * One animation with the effect the motion discrimination actually reads: the
 * properties its keyframes name, and the element it runs on.
 *
 * Separate from `fakeAnimation`, which carries only a play state and so reports as
 * unreadable — the fail-safe arm, and the arm every case written before the
 * discrimination landed depends on. A case about WHICH animations count has to hand
 * over an effect, and this is the smallest one that answers both questions.
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

/** Give one element a Web Animations reading, or take the whole method away. */
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
 * Give the DOCUMENT a Web Animations reading, which the environment these suites run
 * on implements for no node at all.
 *
 * Separate from `withAnimations` rather than folded into it: the document reading is
 * what answers for motion no containment test reaches, so a case has to be able to
 * give the document a running animation while every element in the tree reports none
 * — which is exactly a fixed-size sibling animating beside the subject.
 */
export function withDocumentAnimations(animations: readonly Animation[] | undefined): void {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: animations === undefined ? undefined : () => [...animations],
  });
}

/**
 * Let queued `MutationObserver` records reach their callback.
 *
 * A mutation observer never reports synchronously, so a test that asserted straight
 * after a DOM edit would read the state before delivery every time. A TASK turn and
 * not a microtask one — measured rather than assumed: the DOM implementation these
 * console tiers run on delivers records on a queued task, where the platform
 * delivers them at the end of the microtask checkpoint, and a microtask-only wait
 * reports zero deliveries here. The trailing microtask turn then lets whatever the
 * callback itself scheduled settle before the assertion reads it.
 */
export async function settleMutationRecords(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
}

const attachedRoots: Element[] = [];

/**
 * Hold a root in the live document until the case ends.
 *
 * Every suite in this directory that attaches an element drives these seams — the
 * predicates, the sampling, the composed position observer, the content-layout
 * wiring, the occlusion registry — and each needs elements that are really attached,
 * because a transition on a detached ancestor bubbles to nothing. A private registry
 * per suite is a teardown loop per suite free to drift, and a root left in the
 * document is an observer the next case's document-wide reading still finds. Stated
 * without a count, because the set is every suite that attaches rather than a list
 * that has to be kept.
 */
export function trackAttachedRoot<ElementType extends Element>(root: ElementType): ElementType {
  attachedRoots.push(root);
  return root;
}

/** `ancestor > element`, both in the live document so events really bubble. */
export function attachedPair(): { readonly ancestor: HTMLElement; readonly element: HTMLElement } {
  const ancestor = document.createElement("div");
  const element = document.createElement("div");
  ancestor.append(element);
  document.body.append(ancestor);
  trackAttachedRoot(ancestor);
  return { ancestor, element };
}

/** Every suite's `afterEach` half. Paired with `vi.unstubAllGlobals()` at the call site. */
export function detachAttachedRoots(): void {
  for (const root of attachedRoots.splice(0)) {
    root.remove();
  }
}
