// What the pane frame drew around a pane body, read back from the DOM the way a person meets it.
// Both of this feature's panes wear one chrome, so both suites share these two readers. Reading
// the DOM (not the chrome's source) is what fails on a body drawing its own header.

/** The class the chrome puts on every crumb, its own current one included. */
const CRUMB_SELECTOR = ".meridian-pane__crumb";

/** The class the chrome puts on the last crumb, the pane's own name. */
const CURRENT_CRUMB_SELECTOR = ".meridian-pane__heading";

/**
 * Every crumb the chrome drew, outermost first, the pane's own name last, as text. An absent
 * trail is an empty array, so a case asserting the chrome is there fails in the case.
 */
export function paneTrailCrumbs(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(CRUMB_SELECTOR)].map(
    (crumb) => crumb.textContent?.trim() ?? "",
  );
}

/** The last address crumb (the entity the pane is a view of), never the pane's own name. */
export function paneSubjectCrumb(container: HTMLElement): string | undefined {
  const addressCrumbs = [...container.querySelectorAll(CRUMB_SELECTOR)].filter(
    (crumb) => !crumb.matches(CURRENT_CRUMB_SELECTOR),
  );
  return addressCrumbs.at(-1)?.textContent?.trim();
}
