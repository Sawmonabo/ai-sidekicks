// A disposal minted per render is not a lifetime.
//
// `useSubjectScopedResource.test.tsx` is about what is open; this file is about the identity
// of the `close` a caller hands in. If `close` sat in the lifetime effect's dependency list,
// an unrelated rerender would run that effect's cleanup, close the still-current resource,
// and recommit the closed value. The negative control drives that dependency list over the
// identical script, since a hook that never closed anything would also satisfy "closed
// nothing".

import { render, type RenderResult } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { NamedFixtureSubject } from "@test/helpers/subject-fixtures.js";
import { useSubjectScopedResource } from "./useSubjectScopedResource.js";
import {
  DISCARDED_SUBJECT,
  ResourceOpenCloseLog,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./useSubjectScopedResource.test-support.js";
import { useSubjectScopedState } from "./useSubjectScopedState.js";

interface FreshCloseProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly ledger: ResourceOpenCloseLog;
  /** Which pass this tree is, so the disposal each one mints can be told apart. */
  readonly pass: number;
  readonly onResource: (resource: OpenResource) => void;
}

/**
 * A caller whose disposal is minted per render.
 *
 * The identity changes on every pass and none of those passes is about the resource. The
 * disposal records the pass that minted it, so the ledger says which one ran.
 */
function FreshCloseProbe(props: FreshCloseProbeProps): ReactElement {
  const { ledger, pass } = props;
  const { value } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => ledger.open(props.subject.name),
    {
      release: (resource) => {
        ledger.close({ name: `${resource.name} closed by pass ${String(pass)}` });
      },
    },
  );
  props.onResource(value);
  return <output>{value.name}</output>;
}

/**
 * Negative control: the resource lifetime keyed on the disposal.
 *
 * Drives the real holder through an effect that depends on `close`, so with a disposal
 * minted per render every rerender closes the resource the frame on screen still reads.
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
    ledger: ResourceOpenCloseLog,
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
    // A fresh disposal alone must not run the lifetime effect's cleanup.
    const ledger = new ResourceOpenCloseLog();
    const passes = renderPasses(ledger, FreshCloseProbe, [
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
      DISCARDED_SUBJECT,
    ]);

    expect(ledger.opened).toStrictEqual(["discarded"]);
    expect(ledger.closed).toStrictEqual([]);
    // The component still reads through the resource it opened, not a replacement minted to
    // cover for one closed underneath it.
    expect(new Set(passes.resources).size).toBe(1);
  });

  it("closes the retired resource once, through the newest disposal", () => {
    // The move that is a lifetime, over the same script: two passes at one subject and a
    // third at another. One close, by the pass that retired it.
    const ledger = new ResourceOpenCloseLog();
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
    // The same script against the disposal-keyed lifetime. Nothing opens to replace what it
    // closes, so the component renders a resource that has been disposed twice; this is what
    // makes the claim above about the dependency list and not the script.
    const ledger = new ResourceOpenCloseLog();
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
