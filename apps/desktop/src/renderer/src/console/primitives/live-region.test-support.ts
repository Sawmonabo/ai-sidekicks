// How both announcer suites find the regions.
//
// One home for the one query, on `apps/desktop/AGENTS.md`'s hoist-on-second-use
// rule: `LiveRegion.test.tsx` asserts what a region does with an announcement and
// `LiveAnnouncerProvider.test.tsx` asserts that the provider mounts the pair before
// anything is said, so both have to address them. Two copies of the selector is how
// one suite comes to look for `[data-live-region]` and the other for a class name,
// with nothing reporting the difference the day the attribute is renamed.

/** Both regions, in document order: polite first, assertive second. */
export function regionsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-live-region]")];
}
