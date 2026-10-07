// How every announcer suite finds the regions and reads what one is saying.
//
// One home for the `[data-live-region]` query, so two suites cannot drift onto different
// selectors. A missing region throws rather than reading `""`: assertions over these lanes are
// often `toBe("")`, and a window with no announcer must not read as one that said nothing. The
// throw names the politeness, since which lane is missing is what a reader acts on.

import { type AnnouncementPoliteness } from "#renderer/components/LiveAnnouncer/announcer.js";

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

/**
 * The `ignore` a text query passes to find the words drawn on screen, never the announcer's copy
 * of them; it keeps Testing Library's own `script, style`.
 */
export const OUTSIDE_LIVE_REGIONS = "script, style, [data-live-region]";

/** The words a container draws, without the announcer's copy of them in its regions. */
export function drawnText(container: HTMLElement): string {
  const drawn = container.cloneNode(true) as HTMLElement;
  for (const region of drawn.querySelectorAll("[data-live-region]")) {
    region.remove();
  }
  return drawn.textContent ?? "";
}
