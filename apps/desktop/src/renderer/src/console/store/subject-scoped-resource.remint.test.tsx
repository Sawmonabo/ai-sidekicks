// A `close` that is terminal is re-minted, never re-committed.
//
// Split from `subject-scoped-resource.test.tsx` on the seam the hook draws: that file
// is about WHAT IS OPEN and `subject-scoped-resource.fresh-close.test.tsx` about the
// identity of the disposal, while this one is about the fact neither could say — that
// a caller's `close` may END a resource rather than release it.
//
// THE DEFECT IN TERMS, and it is React's double-mount rather than anything exotic: the
// lifetime effect commits a resource, the cleanup for that same commit disposes it,
// and the effect then runs again against the value it just closed and re-commits it.
// Nothing leaks and nothing is closed twice — the subject simply goes on holding a
// resource that will never work again, which is invisible until something reads
// through it. The browser pane's geometry publisher is exactly that shape: its `close`
// is a one-way `dispose()` and it reports `isDisposed`.
//
// The subjects and the open/close record are `subject-scoped-resource.test-support.ts`,
// whose ledger answers the reading by IDENTITY — a re-mint carries the same name as
// the value it replaces, so a reading keyed on the name would loop.

import { render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { NamedFixtureSubject } from "./subject-fixtures.test-support.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "./subject-scoped-resource.js";
import {
  DISCARDED_SUBJECT,
  ResourceLedger,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./subject-scoped-resource.test-support.js";

interface RemintProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly ledger: ResourceLedger;
  /** Whether this caller's `close` is terminal, which is the whole difference. */
  readonly declaresTerminalClose: boolean;
  /** Every value a render read, so the last one is what the subject ended up holding. */
  readonly onResource: (resource: OpenResource) => void;
}

/**
 * A caller whose disposal is terminal, and the same caller without the reading.
 *
 * One component for both, because two would differ in more than the fact under test:
 * what a control has to hold constant here is the render tree, the subject, and the
 * ledger, and vary only whether the hook is told the disposal ends the resource.
 */
function RemintProbe(props: RemintProbeProps): ReactElement {
  const { ledger } = props;
  const { value } = useSubjectScopedResource<OpenResource>(
    props.subject,
    undefined,
    () => ledger.open(props.subject.name),
    props.declaresTerminalClose
      ? { dispose: ledger.close, isClosed: ledger.isClosed }
      : { release: ledger.close },
  );
  props.onResource(value);
  return <output>{value.name}</output>;
}

/** The value the last render read — what the subject is holding now. */
function heldBy(seen: readonly OpenResource[]): OpenResource {
  const held = seen.at(-1);
  if (held === undefined) {
    throw new Error("the probe rendered no resource at all");
  }
  return held;
}

describe("useSubjectScopedResource — a resource its own close ended is re-minted", () => {
  it("holds a live resource after React's double-mount, not the one it disposed", () => {
    // The double-mount runs the committed cleanup and then the effect again, against
    // the value that cleanup closed. The subject must be holding something usable.
    const ledger = new ResourceLedger();
    const seen: OpenResource[] = [];
    render(
      <StrictMode>
        <RemintProbe
          subject={SETTLED_SUBJECT}
          ledger={ledger}
          declaresTerminalClose
          onResource={(resource) => seen.push(resource)}
        />
      </StrictMode>,
    );

    expect(ledger.isClosed(heldBy(seen))).toBe(false);
    // Opened twice and closed once: the replacement, and the corpse it replaced. The
    // corpse reaches the holder's disposal as an ordinary replaced value with no
    // commit holding it, and a second `dispose()` is what a terminal close refuses.
    expect(ledger.opened).toStrictEqual(["settled", "settled"]);
    expect(ledger.closed).toStrictEqual(["settled"]);
  });

  it("negative control: without the reading the same script installs the corpse", () => {
    // The behaviour every caller had, and still has where a `close` releases rather
    // than ends. Without it the case above would be satisfied by a fixture that never
    // reached the double-mount teardown at all, and by a hook that had stopped closing.
    const ledger = new ResourceLedger();
    const seen: OpenResource[] = [];
    render(
      <StrictMode>
        <RemintProbe
          subject={SETTLED_SUBJECT}
          ledger={ledger}
          declaresTerminalClose={false}
          onResource={(resource) => seen.push(resource)}
        />
      </StrictMode>,
    );

    expect(ledger.isClosed(heldBy(seen))).toBe(true);
    expect(ledger.opened).toStrictEqual(["settled"]);
    expect(ledger.closed).toStrictEqual(["settled"]);
  });

  it("leaves a resource that disposed itself alone while nothing else moves", () => {
    // The arm the browser pane relies on being TERMINAL: a publisher that self-disposes
    // after the host says its pane is gone must not be replaced by a fresh one writing
    // to a host that has nothing to draw. The lifetime effect depends on the resource
    // alone, so a self-disposal re-runs nothing — and this states that as a claim
    // rather than leaving it as a property of the dependency list.
    const ledger = new ResourceLedger();
    const seen: OpenResource[] = [];
    const { rerender } = render(
      <RemintProbe
        subject={SETTLED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );
    const committed = heldBy(seen);
    ledger.close(committed);

    rerender(
      <RemintProbe
        subject={SETTLED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );

    expect(ledger.opened).toStrictEqual(["settled"]);
    expect(heldBy(seen)).toBe(committed);
  });

  it("still opens per subject, and closes the resource the swap retires", () => {
    // The re-mint is about one subject's value ending; it changes nothing about the
    // holder's own rule. A swap — the window handing this surface a different bridge —
    // opens the new subject's resource and retires the old one through the effect.
    const ledger = new ResourceLedger();
    const seen: OpenResource[] = [];
    const { rerender } = render(
      <RemintProbe
        subject={SETTLED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );
    rerender(
      <RemintProbe
        subject={DISCARDED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );

    expect(ledger.opened).toStrictEqual(["settled", "discarded"]);
    expect(ledger.closed).toStrictEqual(["settled"]);
    expect(heldBy(seen).name).toBe("discarded");
  });
});

describe("useSubjectScopedResource — a terminal disposal cannot omit its reading", () => {
  it("refuses `{ dispose }` with no `isClosed`, at compile time and not at runtime", () => {
    // THE CONTROL IS THE DIRECTIVE, AND IT IS CHECKED BY `tsc` RATHER THAN BY VITEST.
    // This is the whole reason the disposal is one argument: the reading used to be a
    // fifth positional parameter, so a caller whose `close` was one-way could simply
    // not pass it and the omission was invisible — the corpse this file is about,
    // arrived at by leaving something out. As a member of a union arm it cannot be
    // left out, and `@ts-expect-error` fails the typecheck the moment that stops
    // being true, because an unused directive is itself an error. Proven by planting
    // the valid shape here, which reported exactly that.
    //
    // The directive sits on the DECLARATION rather than on the missing member,
    // because that is where an assignability failure over an object literal is
    // reported — one line down and it would be an unused directive beside a real
    // error, which is a red typecheck saying the wrong thing.
    // @ts-expect-error a terminal disposal has to say how a closed resource reads
    const refusedDisposal: SubjectScopedDisposal<OpenResource> = {
      dispose: () => undefined,
    };

    expect(refusedDisposal).toBeTypeOf("object");
  });

  it("accepts the two arms it does declare", () => {
    // The other side of the same line: neither shape is refused, so the control above
    // is discriminating between the arms rather than rejecting the argument outright.
    const released: SubjectScopedDisposal<OpenResource> = { release: () => undefined };
    const disposed: SubjectScopedDisposal<OpenResource> = {
      dispose: () => undefined,
      isClosed: () => true,
    };

    expect([released, disposed]).toHaveLength(2);
  });
});
