// A `close` that is terminal is re-minted, never re-committed.
//
// React's double mount commits a resource, disposes it in that commit's cleanup, then re-runs
// the effect against the value it just closed. Nothing leaks and nothing is closed twice, but
// the subject goes on holding a resource that will never work again. The preview pane's
// `PaneGeometryPublisher` has that shape: a one-way `dispose()` and an `isDisposed` reading.
//
// `useSubjectScopedResource.test.tsx` covers what is open and
// `useSubjectScopedResource.fresh-close.test.tsx` the identity of the disposal. The ledger in
// `useSubjectScopedResource.test-support.ts` answers the reading by identity, because a
// re-mint carries the same name as the value it replaces and a reading keyed on the name
// would loop.

import { render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { NamedFixtureSubject } from "@test/helpers/subject-fixtures.js";
import { useSubjectScopedResource } from "./useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import {
  DISCARDED_SUBJECT,
  ResourceOpenCloseLog,
  SETTLED_SUBJECT,
  type OpenResource,
} from "./useSubjectScopedResource.test-support.js";

interface DoubleMountProbeProps {
  readonly subject: NamedFixtureSubject;
  readonly ledger: ResourceOpenCloseLog;
  /** Whether this caller's `close` is terminal, which is the whole difference. */
  readonly declaresTerminalClose: boolean;
  /** Every value a render read, so the last one is what the subject ended up holding. */
  readonly onResource: (resource: OpenResource) => void;
}

/**
 * A caller whose disposal is terminal, and the same caller without the reading.
 *
 * One component for both, so the render tree, subject and ledger stay constant and only
 * whether the hook is told the disposal ends the resource varies.
 */
function DoubleMountProbe(props: DoubleMountProbeProps): ReactElement {
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
    // The double mount runs the committed cleanup and then the effect again against the value
    // that cleanup closed; the subject must hold something usable.
    const ledger = new ResourceOpenCloseLog();
    const seen: OpenResource[] = [];
    render(
      <StrictMode>
        <DoubleMountProbe
          subject={SETTLED_SUBJECT}
          ledger={ledger}
          declaresTerminalClose
          onResource={(resource) => seen.push(resource)}
        />
      </StrictMode>,
    );

    expect(ledger.isClosed(heldBy(seen))).toBe(false);
    // Opened twice, closed once: the replacement, and the corpse it replaced. The corpse
    // reaches the holder's disposal as an ordinary replaced value, and a second `dispose()`
    // is what a terminal close refuses.
    expect(ledger.opened).toStrictEqual(["settled", "settled"]);
    expect(ledger.closed).toStrictEqual(["settled"]);
  });

  it("negative control: without the reading the same script installs the corpse", () => {
    // What every caller gets where a `close` releases rather than ends. Without it the case
    // above would be satisfied by a fixture that never reached the double-mount teardown, or
    // by a hook that stopped closing.
    const ledger = new ResourceOpenCloseLog();
    const seen: OpenResource[] = [];
    render(
      <StrictMode>
        <DoubleMountProbe
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
    // The arm the preview pane's geometry publisher relies on: one that disposes itself must
    // not be replaced by a fresh one. The lifetime effect depends on the resource alone, so a
    // self-disposal re-runs nothing.
    const ledger = new ResourceOpenCloseLog();
    const seen: OpenResource[] = [];
    const { rerender } = render(
      <DoubleMountProbe
        subject={SETTLED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );
    const committed = heldBy(seen);
    ledger.close(committed);

    rerender(
      <DoubleMountProbe
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
    // The re-mint is about one subject's value ending and changes nothing about the holder's
    // own rule: a swap opens the new subject's resource and retires the old one through the
    // effect.
    const ledger = new ResourceOpenCloseLog();
    const seen: OpenResource[] = [];
    const { rerender } = render(
      <DoubleMountProbe
        subject={SETTLED_SUBJECT}
        ledger={ledger}
        declaresTerminalClose
        onResource={(resource) => seen.push(resource)}
      />,
    );
    rerender(
      <DoubleMountProbe
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
    // Checked by `tsc`, not vitest. The disposal is one argument so a caller whose `close` is
    // one-way cannot omit the reading: as a required member of a union arm it cannot be left
    // out, and `@ts-expect-error` fails the typecheck the moment that stops being true. The
    // directive sits on the declaration because that is where an assignability failure over
    // an object literal is reported.
    // @ts-expect-error a terminal disposal has to say how a closed resource reads
    const refusedDisposal: SubjectScopedDisposal<OpenResource> = {
      dispose: () => undefined,
    };

    expect(refusedDisposal).toBeTypeOf("object");
  });

  it("accepts the two arms it does declare", () => {
    // The other side of the same line: neither shape is refused, so the control above
    // discriminates between the arms rather than rejecting the argument outright.
    const released: SubjectScopedDisposal<OpenResource> = { release: () => undefined };
    const disposed: SubjectScopedDisposal<OpenResource> = {
      dispose: () => undefined,
      isClosed: () => true,
    };

    expect([released, disposed]).toHaveLength(2);
  });
});
