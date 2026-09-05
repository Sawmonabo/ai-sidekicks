// A disposal minted per render is not a lifetime.
//
// Split from `subject-scoped-resource.test.tsx` on the seam the hook itself draws:
// that file is about WHAT IS OPEN — which render opened a resource and which close
// retires it — and this one is about the identity of the `close` a caller hands in.
// The two are separate because the defect was: `close` sat in the resource lifetime's
// dependency list, so an unrelated rerender ran that effect's cleanup, closed the
// still-current resource, and then recommitted the closed value.
//
// The claim is paired with a NEGATIVE CONTROL driving the dependency list this
// replaced over the identical script. Without it, "closed nothing" would be a
// sentence about a test: a hook that never closed anything would satisfy it too.

import { render, type RenderResult } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import { useSubjectScopedResource } from "./subject-scoped-resource.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";
import { useSubjectScopedState } from "./subject-scoped-state.js";

interface FreshCloseProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly ledger: ResourceLedger;
  /** Which pass this tree is, so the disposal each one mints can be told apart. */
  readonly pass: number;
  readonly onResource: (resource: OpenResource) => void;
}

/**
 * A caller whose disposal is minted per render — the shape the hook documents.
 *
 * The identity handed in changes on every pass, and none of those passes is about
 * the resource. What the disposal RECORDS is the pass that minted it, so the ledger
 * says which one ran rather than only that something did.
 */
function FreshCloseProbe(props: FreshCloseProbeProps): ReactElement {
  const { ledger, pass } = props;
  const { value } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => ledger.open(props.subject.name),
    (resource) => {
      ledger.close({ name: `${resource.name} closed by pass ${String(pass)}` });
    },
  );
  props.onResource(value);
  return <output>{value.name}</output>;
}

/**
 * The dependency list this replaced: the resource's lifetime keyed on the disposal.
 *
 * Not a stand-in for the hook — it drives the real holder through the effect the
 * resource lifetime used to run, which is the one thing these cases are about. With
 * a disposal minted per render, every rerender runs that effect's cleanup and closes
 * the resource the frame on screen is still reading through.
 */
function CloseKeyedLifetimeProbe(props: FreshCloseProbeProps): ReactElement {
  const { ledger, pass } = props;
  const { value } = useSubjectScopedState<OpenResource>(props.subject, undefined, () =>
    ledger.open(props.subject.name),
  );
  const close = (resource: OpenResource): void => {
    ledger.close({ name: `${resource.name} closed by pass ${String(pass)}` });
  };
  useEffect(() => {
    return () => {
      close(value);
    };
  }, [value, close]);
  props.onResource(value);
  return <output>{value.name}</output>;
}

describe("useSubjectScopedResource — a disposal minted per render is not a lifetime", () => {
  /** Every pass renders the same tree; only the disposal identity moves. */
  function renderPasses(
    ledger: ResourceLedger,
    Probe: (props: FreshCloseProbeProps) => ReactElement,
    subjects: readonly [NamedFixtureSubject, ...NamedFixtureSubject[]],
  ): { readonly view: RenderResult; readonly resources: readonly OpenResource[] } {
    const resources: OpenResource[] = [];
    const record = (resource: OpenResource): void => {
      resources.push(resource);
    };
    const treeAt = (subject: NamedFixtureSubject, pass: number): ReactElement => (
      <Probe subject={subject} ledger={ledger} pass={pass} onResource={record} />
    );
    const [first, ...rest] = subjects;
    const view = render(treeAt(first, 1));
    rest.forEach((subject, index) => {
      view.rerender(treeAt(subject, index + 2));
    });
    return { view, resources };
  }

  it("closes nothing on a rerender that only minted a fresh disposal", () => {
    // The defect: `close` sat in the resource lifetime's dependency list, so an
    // unrelated rerender ran that effect's cleanup — closing the still-current
    // resource and then recommitting the closed value.
    const ledger = new ResourceLedger();
    const passes = renderPasses(ledger, FreshCloseProbe, [
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
    ]);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([]);
    // And the surface is still reading through the resource it opened, rather than
    // through a replacement minted to cover for one that was closed underneath it.
    expect(new Set(passes.resources).size).toBe(1);
  });

  it("closes the retired resource once, through the newest disposal", () => {
    // The move that IS a lifetime, driven over the same script: two passes at one
    // subject and a third at another. One close, and by the pass that retired it.
    const ledger = new ResourceLedger();
    const passes = renderPasses(ledger, FreshCloseProbe, [
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
      SETTLED_SUBJECT,
    ]);

    expect(ledger.opened).toStrictEqual(["discarded", "settled"]);
    expect(ledger.closed).toStrictEqual(["discarded closed by pass 3"]);

    passes.view.unmount();
    expect(ledger.closed).toStrictEqual(["discarded closed by pass 3", "settled closed by pass 3"]);
  });

  it("negative control: the disposal-keyed lifetime closes the resource on screen", () => {
    // The identical script against the dependency list this replaced. Nothing was
    // opened to replace what it closed, so the surface goes on rendering a resource
    // that has been disposed twice — which is the defect, and the reason the claim
    // above is about the dependency list rather than about the script.
    const ledger = new ResourceLedger();
    const passes = renderPasses(ledger, CloseKeyedLifetimeProbe, [
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
    ]);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([
      "discarded closed by pass 1",
      "discarded closed by pass 2",
    ]);
    expect(new Set(passes.resources).size).toBe(1);
    expect(passes.view.container.textContent).toBe("discarded");
  });
});
