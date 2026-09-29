// How every announcer suite finds the regions, and reads what one is saying.
//
// One home for the one query, on `apps/desktop/AGENTS.md`'s hoist-on-second-use
// rule: `LiveRegion.test.tsx` asserts what a region does with an announcement and
// `LiveAnnouncerProvider.test.tsx` asserts that the provider mounts the pair before
// anything is said, so both have to address them. Two copies of the selector is how
// one suite comes to look for `[data-live-region]` and the other for a class name,
// with nothing reporting the difference the day the attribute is renamed.
//
// AND THE LANE READING. Every suite that reads what a lane is saying reads it through
// `liveRegionOf` and the text readers below, so the `[data-live-region="…"]` lookup is
// written once.
//
// A MISSING REGION THROWS RATHER THAN READING AS SILENCE. Answering `?? ""` would say
// "the announcer said nothing" for a window that mounted no announcer at all — and every
// assertion over these lanes is `toBe("")` at least as often as it is anything else, so
// the two states are exactly the ones a reader cannot afford to have conflated. The throw
// names the politeness, because which lane is missing is what a reader does something
// about.

import { type AnnouncementPoliteness } from "@renderer/components/LiveAnnouncer/live-announcer.js";

/** Both regions, in document order: polite first, assertive second. */
export function regionsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-live-region]")];
}

/** One lane's region, or a throw naming the lane that is not mounted. */
export function liveRegionOf(
  container: HTMLElement,
  politeness: AnnouncementPoliteness,
): HTMLElement {
  const region = container.querySelector<HTMLElement>(`[data-live-region="${politeness}"]`);
  if (region === null) {
    throw new Error(`this container mounted no ${politeness} live region`);
  }
  return region;
}

/** What one lane is currently saying — `""` where it has said nothing. */
export function liveRegionText(container: HTMLElement, politeness: AnnouncementPoliteness): string {
  return liveRegionOf(container, politeness).textContent ?? "";
}

/** What the polite lane is saying, which is the lane most callers mean. */
export function politeText(container: HTMLElement): string {
  return liveRegionText(container, "polite");
}
