// The two openers this destination hands down, and whether they hold still.
//
// SEPARATE FROM `WorkflowsDestination.test.tsx` BECAUSE THE TWO LISTS ARE SUBSTITUTED
// HERE, and that file's premise is that both are real. What a prop's IDENTITY is across
// a re-render is not a fact any rendered markup carries — the same rows draw the same
// way whether the opener beneath them was rebuilt or not — so the only place to read it
// is where it is handed over. Both probes record what they were given and render
// nothing else; the behaviour they stand in for is driven end to end by that file and by
// `WorkflowsPaneHost.test.tsx`.
//
// WHY IT MATTERS. `WorkflowRuns` memoizes its projection on the read state, so a row
// value is replaced when and only when something in that run changed — which is what
// makes `RunListItem`'s `memo` worth having and what makes its defeat measurable. Minted
// inline, the openers were a fresh identity every pass, the shallow compare failed for
// every row, and any state change above re-rendered the whole list.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthPort } from "../bridge/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { FrameStore, type SessionStoreRegistry } from "../store/index.js";
import type { ConsolePaneAddress, ConsolePaneOpener } from "../seats/index.js";
import { chosenScope } from "./destination-scope.js";
import { definition, PROBE_SESSION_ID } from "./WorkflowsBrowser.test-support.js";
import { WorkflowsDestination } from "./WorkflowsDestination.js";

/**
 * What each list was handed, in render order.
 *
 * Boxes hoisted with the mocks rather than values closed over: `vi.mock` factories are
 * lifted above the imports, so a plain binding is not initialised when they run.
 */
const handedDown = vi.hoisted(() => ({
  definitionOpeners: [] as unknown[],
  runOpeners: [] as unknown[],
}));

vi.mock("./WorkflowsBrowser.js", () => ({
  WorkflowsBrowser: (props: { readonly onOpenDefinition?: unknown }) => {
    handedDown.definitionOpeners.push(props.onOpenDefinition);
    return null;
  },
}));

vi.mock("./runs/WorkflowRuns.js", () => ({
  WorkflowRuns: (props: { readonly onOpenRun?: unknown }) => {
    handedDown.runOpeners.push(props.onOpenRun);
    return null;
  },
}));

/**
 * The destination on its `chosen` arm, which is the arm that mounts both lists.
 *
 * The port and the registry are cast rather than built: neither list is real here, so
 * no read is put, and the picker arm — the one place the registry is read — is not the
 * arm a chosen scope takes.
 */
function renderDestination(openPane: ConsolePaneOpener): ReturnType<typeof render> {
  return render(destination(openPane));
}

/** The element every case renders, so a re-render differs only where a case says. */
function destination(openPane: ConsolePaneOpener): React.JSX.Element {
  return (
    <LiveAnnouncerProvider>
      <WorkflowsDestination
        growth={{} as GrowthPort}
        frameStore={new FrameStore({})}
        sessionStoreRegistry={{} as SessionStoreRegistry}
        scope={chosenScope(PROBE_SESSION_ID)}
        onScopeChange={vi.fn()}
        openPane={openPane}
      />
    </LiveAnnouncerProvider>
  );
}

/** What the definitions browser was handed on the most recent render. */
function latestDefinitionOpener(): (row: ReturnType<typeof definition>) => void {
  const opener = handedDown.definitionOpeners.at(-1);
  if (typeof opener !== "function") {
    throw new Error("the destination handed the browser no opener");
  }
  return opener as (row: ReturnType<typeof definition>) => void;
}

describe("the openers the destination hands its two lists", () => {
  it("hands both lists the same opener across a re-render", () => {
    const openPane = vi.fn();
    const rendered = renderDestination(openPane);
    rendered.rerender(destination(openPane));

    // The premise: there really were two renders to compare.
    expect(handedDown.definitionOpeners.length).toBeGreaterThanOrEqual(2);
    expect(handedDown.definitionOpeners.at(-1)).toBe(handedDown.definitionOpeners.at(-2));
    expect(handedDown.runOpeners.at(-1)).toBe(handedDown.runOpeners.at(-2));
  });

  it("negative control: a different destination for opened panes is a different opener", () => {
    // Without this, the case above would pass over openers memoized on an empty
    // dependency list — which would go on opening panes into the surface that mounted
    // the destination first, however the surface above had since been recomposed.
    const rendered = renderDestination(vi.fn());
    const openersBefore = handedDown.runOpeners.length;
    rendered.rerender(destination(vi.fn()));

    expect(handedDown.runOpeners.length).toBeGreaterThan(openersBefore);
    expect(handedDown.runOpeners.at(-1)).not.toBe(handedDown.runOpeners.at(openersBefore - 1));
  });

  it("negative control: the opener it hands down still opens what it is called with", () => {
    // Without this, the two cases above would be satisfied by a stable callback that
    // opened nothing — the identity claim says where the address comes from and not
    // that one arrives.
    const openPane = vi.fn<(address: ConsolePaneAddress) => void>();
    renderDestination(openPane);
    latestDefinitionOpener()(definition({ id: "release-checklist" }));

    expect(openPane).toHaveBeenCalledWith({
      kind: "workflow-builder",
      entity: { kind: "workflow-definition", id: "release-checklist" },
    });
  });
});
