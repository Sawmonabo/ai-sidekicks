// What the browser's suites need before they can read anything off a render.
//
// One home for the four queries the grouping and continuation suites both run — a
// browser rendered two ways, the group a scope's rows sit in, and the names in it.
// Held together because they are one vocabulary: a class name the component renames is
// one edit here rather than a search across the suites.
//
// THE ROW ITSELF IS NOT HERE. `WorkflowDefinitionRow` is the family's fixture, not this
// directory's — the browser's own suites, one directory over, build the same row — so
// the factory lives at `../workflows-probe.test-support.ts` and these suites import it.
// What is here is what only a `DefinitionsBrowser` render can answer.
//
// The two render helpers answer different questions and both are needed. Most cases
// read the SCOPE LIST, because that is where the groups and their rows are. The
// continuation region is a SIBLING of the groups rather than a member of one — the
// cursor pages the enumeration across every scope at once — so the cases about it
// read the container the two share.
//
// What is deliberately NOT here is anything one suite reads: the resolution-mark
// queries, the continuation control, and the compile-time row-shape foil each have a
// single reader and stay beside it.

import { render } from "@testing-library/react";

/** The whole browser, continuation region included. */
export function renderDefinitionsBrowser(element: React.JSX.Element): HTMLElement {
  return render(element).container;
}

/** The scope list alone, which is where the groups and their rows are. */
export function renderScopeList(element: React.JSX.Element): HTMLElement {
  const list = renderDefinitionsBrowser(element).querySelector(".meridian-workflow__scopes");
  if (!(list instanceof HTMLElement)) {
    throw new Error("the browser rendered no scope list");
  }
  return list;
}

/** The group a named scope's rows sit in, or a failure naming the scope. */
export function groupFor(list: HTMLElement, scope: string): HTMLElement {
  const groups = [...list.querySelectorAll<HTMLElement>(".meridian-workflow__scope")];
  const group = groups.find(
    (candidate) =>
      candidate.querySelector(".meridian-workflow__scope-heading")?.textContent === scope,
  );
  if (group === undefined) {
    throw new Error(`no group rendered for scope ${scope}`);
  }
  return group;
}

/** The definition names rendered inside one group, in render order. */
export function rowNames(group: HTMLElement): readonly string[] {
  return [...group.querySelectorAll(".meridian-definition-row__name")].map(
    (name) => name.textContent ?? "",
  );
}
