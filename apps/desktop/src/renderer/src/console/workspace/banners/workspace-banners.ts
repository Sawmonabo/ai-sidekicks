// The workspace's banner stack: what it coalesces, and what it deliberately keeps.
//
// `Spec-023 §Meridian, the design language` gives a refusal that "changes what the
// whole room can do" the banner shape, and the workspace is where those land. Two
// properties are this stack's own, because neither is a property of one refusal:
//
//   • **A REPEATED REFUSAL IS ONE BANNER WITH A COUNT.** A failing store raises
//     `layout-save-failed` on every pane the person moves, so a drag produced a
//     column of identical banners all saying one thing. Identical is exact and is the
//     whole triple — origin, code and detail — because two refusals that differ in
//     any of the three are two different facts and a reader has to see both.
//   • **AND THE TRIPLE IS THE IDENTITY, WHICH IS WHY THE RENDER KEYS ON IT.** The
//     list was keyed by array position over a list that supports removal, so
//     dismissing the first banner renumbered every one below it: React unmounted and
//     remounted banners that had not changed, which takes focus off the dismiss
//     control somebody was tabbing through and makes a screen reader read them again.
//
// NOTHING IS DROPPED. There is no cap here and no eviction: coalescing bounds the
// repeat, and every banner left is a different sentence about a different thing the
// room can no longer do. A cap would decide, silently, which of those a person does
// not get to read.

import { type ConsoleRefusal } from "../../core/index.js";

/** One banner on screen, and how many raises it stands for. */
export interface WorkspaceBanner {
  readonly refusal: ConsoleRefusal;
  /** 1 for a refusal raised once. Rendered only above 1: a count of one is noise. */
  readonly repeatCount: number;
}

/**
 * The identity of a refusal as this stack counts it.
 *
 * Joined on a NUL rather than on a separator a code or a sentence could contain:
 * with a printable joiner, an origin ending in one and a code starting with one
 * compose the same string as a different pair, and two unrelated refusals would
 * coalesce into one banner carrying a count of both.
 */
export function workspaceBannerKey(refusal: ConsoleRefusal): string {
  return [refusal.origin, refusal.code, refusal.detail].join("\u0000");
}

/**
 * Raise one, coalescing it into the banner that already says it.
 *
 * The repeat REPLACES its entry in place rather than moving it to the end: the
 * banner is already on screen and somebody is reading it, and re-ordering the stack
 * under them to record that the same thing happened again would move the dismiss
 * control they were reaching for.
 */
export function raiseWorkspaceBanner(
  current: readonly WorkspaceBanner[],
  refusal: ConsoleRefusal,
): readonly WorkspaceBanner[] {
  const key = workspaceBannerKey(refusal);
  const standing = current.find((banner) => workspaceBannerKey(banner.refusal) === key);
  if (standing === undefined) {
    return [...current, { refusal, repeatCount: 1 }];
  }
  return current.map((banner) =>
    banner === standing ? { refusal: banner.refusal, repeatCount: banner.repeatCount + 1 } : banner,
  );
}

/**
 * Put one away, by the identity the render keyed it on.
 *
 * Keyed rather than by object identity, because the entry a dismiss control closed
 * over is the one from the render that drew it, and a raise since then has replaced
 * that object with a counted one that is the same banner.
 */
export function dismissWorkspaceBanner(
  current: readonly WorkspaceBanner[],
  key: string,
): readonly WorkspaceBanner[] {
  return current.filter((banner) => workspaceBannerKey(banner.refusal) !== key);
}
