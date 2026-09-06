// What the seats chrome drew around a pane body, read back the way a person meets it.
//
// BOTH OF THIS FAMILY'S PANES WEAR ONE CHROME, so both suites ask it the same two
// questions — what the trail says, and which crumb is the subject the pane is a view
// of — and the reader is hoisted here on the second use rather than written twice.
// It sits at the family root beside `scenario-clock.test-support.ts` because the two
// sub-modules that read it are siblings and neither owns the other.
//
// IT READS THE DOM AND NEVER THE CHROME'S SOURCE. The claim a suite makes with it is
// that the body reached the chrome and handed it the address — a claim that has to
// fail on a body drawing its own header, which is exactly what these selectors do:
// nothing in a family-drawn frame carries `meridian-pane__crumb`.

/** The class the chrome puts on every crumb, its own current one included. */
const CRUMB_SELECTOR = ".meridian-pane__crumb";

/** The class the chrome puts on the LAST crumb — the pane's own name. */
const CURRENT_CRUMB_SELECTOR = ".meridian-pane__heading";

/**
 * Every crumb the chrome drew, outermost first, the pane's own name last.
 *
 * Text rather than elements, because what a suite asserts about a trail is what it
 * says. An absent trail is an empty array rather than a throw: a case whose claim is
 * that the chrome is there reads the length, and a throw here would report that
 * failure from this module rather than from the case that owns the claim.
 */
export function paneTrailCrumbs(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(CRUMB_SELECTOR)].map(
    (crumb) => crumb.textContent?.trim() ?? "",
  );
}

/**
 * The crumb naming the entity the pane is a view of.
 *
 * The LAST address crumb, which `paneScopeCrumbs` orders last of the four it can
 * carry — session, channel, run, then entity — and never the pane's own name, which
 * is prose and carries `meridian-pane__heading` beside the crumb class.
 */
export function paneSubjectCrumb(container: HTMLElement): string | undefined {
  const addressCrumbs = [...container.querySelectorAll(CRUMB_SELECTOR)].filter(
    (crumb) => !crumb.matches(CURRENT_CRUMB_SELECTOR),
  );
  return addressCrumbs.at(-1)?.textContent?.trim();
}
