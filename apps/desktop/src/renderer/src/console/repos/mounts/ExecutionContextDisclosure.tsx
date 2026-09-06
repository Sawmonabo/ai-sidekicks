// The three roots one workspace runs against, disclosed together, with the fallback
// badge beside them.
//
// COLLAPSED BY DEFAULT AND READ ON MOUNT, which is `ProposalGateDisclosure`'s posture
// and for its reason: the summary line reports what was found rather than inviting a
// click to find out, because whether a surface is worth opening is a question only a
// surface that has read can answer. The `<details>` is native for that module's
// reasons too — keyboard reachable, labelled, and focus-visible with no code.
//
// THE BADGE IS OUTSIDE THE DISCLOSURE AND THE PATHS ARE INSIDE IT. A substituted
// execution mode is a fact about the row that a person must not have to open anything
// to see: `Spec-010 §Fallback Behavior` requires it marked distinctly from the mode
// that was asked for, and a marker behind a summary is not marked. The three paths are
// reference detail — correct, needed when something looks wrong, and noise on the
// eighteen rows where all three agree — so they sit behind the summary.
//
// THE REFUSAL RENDERS INLINE AND NAMES ITS OWN WIRE. This read's ordinary answer in a
// shipped build is the growth port's typed absence, which carries the slate row and
// the document that owes the wire; rendering it as a section-level failure would say
// the repos surface is broken when what is true is that one row is not registered yet.

import type { ConsoleBridge } from "../../bridge/index.js";
import { Chip, InlineRefusal, Nothing } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import { useWorkspaceExecutionContext } from "./execution-context-binding.js";
import { ExecutionPathRow } from "./ExecutionPathRow.js";
import {
  executionPathRows,
  fallbackBadgeFor,
  type ExecutionContextReading,
} from "./execution-context-model.js";

export interface ExecutionContextDisclosureProps {
  readonly bridge: ConsoleBridge;
  readonly workspaceId: string;
  /** The mount's resolved root — the first of the three paths, and the fixed one. */
  readonly mountCanonicalRoot: string;
  /** The session this read's reconnect and lifecycle triggers listen to. Passed down. */
  readonly sessionStore: SessionStore;
}

export function ExecutionContextDisclosure(
  props: ExecutionContextDisclosureProps,
): React.JSX.Element {
  const reading = useWorkspaceExecutionContext(props.bridge, props.workspaceId, props.sessionStore);
  const badge = reading.status === "read" ? fallbackBadgeFor(reading.context) : undefined;
  return (
    <div className="meridian-execution-context">
      {badge === undefined ? null : (
        <div className="meridian-execution-context__fallback">
          <Chip label={badge.label} mono tone="attention" glyph="alert" />
          <p className="meridian-execution-context__fallback-sentence">{badge.sentence}</p>
        </div>
      )}
      <details className="meridian-execution-context__paths">
        <summary className="meridian-execution-context__summary">
          Execution roots
          <span className="meridian-execution-context__line">{summaryLineFor(reading)}</span>
        </summary>
        {renderBody(props, reading)}
      </details>
    </div>
  );
}

/**
 * One honest line per reading, for a summary that has room for exactly one.
 *
 * TOTAL OVER THE FOUR ARMS, so a fifth would fail to compile here rather than falling
 * through to a line about some other state. The served arm's line reports what the
 * disclosure would show — whether the three roots agree — because that is the one
 * question a person opens it to answer, and a summary that answered it saves the open.
 */
function summaryLineFor(reading: ExecutionContextReading): string {
  switch (reading.status) {
    case "not-read":
      return "not read";
    case "reading":
      return "reading";
    case "refused":
      return `not available — ${reading.refusal.code}`;
    case "read":
      return reading.context.checkoutRoot === undefined
        ? "no captured checkout root"
        : reading.context.checkoutRoot === reading.context.boundRoot
          ? "all three roots agree"
          : "the roots differ";
  }
}

/**
 * What sits inside the disclosure, per arm.
 *
 * THE THREE ABSENCES ARE THREE DIFFERENT CARDS. Rule 8 separates a question never put
 * from one in flight from one that was refused, and this read reaches all three in
 * ordinary use: a row whose disclosure has never been opened has not read, a row read
 * against a shipped build is refused by the growth port, and a row read against the
 * fixture answers. A single "nothing to show" card would make the second of those look
 * like the first, which invites a wait for an answer already back.
 */
function renderBody(
  props: ExecutionContextDisclosureProps,
  reading: ExecutionContextReading,
): React.JSX.Element {
  switch (reading.status) {
    case "not-read":
      return <Nothing kind="not-checked" title="The execution roots have not been read." />;
    case "reading":
      return <Nothing kind="computing" title="Reading this workspace's execution roots." />;
    case "refused":
      return <InlineRefusal code={reading.refusal.code} detail={reading.refusal.detail} />;
    case "read":
      return (
        <dl className="meridian-execution-context__list">
          {executionPathRows(props.mountCanonicalRoot, reading.context).map((row) => (
            <ExecutionPathRow key={row.label} row={row} />
          ))}
        </dl>
      );
  }
}
