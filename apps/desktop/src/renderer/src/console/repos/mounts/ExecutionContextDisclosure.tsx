// The three roots one workspace runs against, disclosed together, with the fallback
// badge beside them.
//
// COLLAPSED BY DEFAULT AND READ ON MOUNT, which is `ProposalGateDisclosure`'s posture
// and for its reason: the summary line reports what was found rather than inviting a
// click to find out, because whether a surface is worth opening is a question only a
// surface that has read can answer. The `<details>` is native for that module's
// reasons too — keyboard reachable, labelled, and focus-visible with no code.
//
// EXCEPT ON A `stale` WORKSPACE, WHERE IT OPENS ITSELF. This family's density is
// fixed: the three paths collapse behind one disclosure, expanded by default only
// while the workspace is `stale`. That is the one
// position where the roots are the question rather than reference detail — writable
// runs are blocked until repair and which root stopped answering is the next thing a
// person looks at.
//
// THE DEFAULT IS A TRANSITION RULE, NOT A RENDER RULE, and the asymmetry is deliberate:
// the edge INTO `stale` opens the disclosure, whether it arrives at mount or at a later
// read, and no other transition touches it. So a participant who closes it on a stale
// row stays closed — the section re-reads on four separate reasons and a control that
// reopened on each of them is a control nobody can put away — and a row that RECOVERS
// never slams shut on the person reading it. The rule is stated in
// `execution-context-model.ts` and applied by `execution-context-binding.ts`'s hook,
// beside the reader, because comparing this render's position against the last one is a
// lifecycle collaboration rather than a render. The state is per mounted row and
// ephemeral: nothing is written through `console/persistence/`, because where a
// disclosure stands is not a fact about the session.
//
// THE BADGE IS OUTSIDE THE DISCLOSURE AND THE PATHS ARE INSIDE IT. A substituted
// execution mode is a fact about the row that a person must not have to open anything
// to see: it is marked distinctly from the mode that was asked for, and a marker
// behind a summary is not marked. The three paths are
// reference detail — correct, needed when something looks wrong, and noise on every
// row where all three agree — so they sit behind the summary.
//
// THE REFUSAL RENDERS INLINE AND NAMES ITS OWN WIRE. This read's ordinary answer in a
// shipped build is the growth port's typed absence, which carries the slate row and
// the document that owes the wire; rendering it as a section-level failure would say
// the repos surface is broken when what is true is that one row is not registered yet.

import type { WorkspaceState } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../bridge/index.js";
import { Chip, InlineRefusal, Nothing } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import {
  useExecutionRootsDisclosure,
  useWorkspaceExecutionContext,
} from "./execution-context-binding.js";
import { ExecutionPathRow } from "./ExecutionPathRow.js";
import {
  executionPathRows,
  executionRootsSummaryLine,
  fallbackBadgeFor,
  type ExecutionContextReading,
} from "./execution-context-model.js";

export interface ExecutionContextDisclosureProps {
  readonly bridge: ConsoleBridge;
  readonly workspaceId: string;
  /** The mount's resolved root — the first of the three paths, and the fixed one. */
  readonly mountCanonicalRoot: string;
  /**
   * The workspace's lifecycle position, which is what decides the default above.
   *
   * The POSITION and not a boolean, so the density rule is stated against the wire's
   * own union here rather than against a caller's reading of it — a row that started
   * passing `busy` as "not stale" would be a second opinion about a fact the workspace
   * list already carries.
   */
  readonly workspaceState: WorkspaceState;
  /** The session this read's reconnect and lifecycle triggers listen to. Passed down. */
  readonly sessionStore: SessionStore;
}

export function ExecutionContextDisclosure(
  props: ExecutionContextDisclosureProps,
): React.JSX.Element {
  const reading = useWorkspaceExecutionContext(props.bridge, props.workspaceId, props.sessionStore);
  const badge = reading.status === "read" ? fallbackBadgeFor(reading.context) : undefined;
  const disclosure = useExecutionRootsDisclosure(props.workspaceState);
  return (
    <div className="meridian-execution-context">
      {badge === undefined ? null : (
        <div className="meridian-execution-context__fallback">
          <Chip label={badge.label} mono tone="attention" glyph="alert" />
          <p className="meridian-execution-context__fallback-sentence">{badge.sentence}</p>
        </div>
      )}
      <details
        className="meridian-execution-context__paths"
        open={disclosure.isOpen}
        onToggle={(event) => {
          disclosure.onToggle(event.currentTarget.open);
        }}
      >
        <summary className="meridian-execution-context__summary">
          Execution roots
          <span className="meridian-execution-context__line">
            {executionRootsSummaryLine(reading, props.mountCanonicalRoot)}
          </span>
        </summary>
        {renderBody(props, reading)}
      </details>
    </div>
  );
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
