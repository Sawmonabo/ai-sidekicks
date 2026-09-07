import { useCloneExpiryInstant } from "./clone-expiry-wake-up.js";
import { type RepoMountsReading } from "./repo-mounts-model.js";
import { type ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";

import { EphemeralCloneGateRow } from "../proposals/EphemeralCloneGateRow.js";
import { ephemeralCloneGateSubject } from "../proposals/proposal-gate-model.js";
import { Nothing } from "../../primitives/index.js";
import { type ExecutionMode } from "@ai-sidekicks/contracts";

export interface EphemeralCloneListProps {
  readonly reading: RepoMountsReading;
  /** Passed down rather than reached for: each clone's gate performs its own read. */
  readonly bridge: ConsoleBridge;
  /** Passed down for the same reason: each clone's gate arms its own refresh triggers. */
  readonly sessionStore: SessionStore;
  /** Read the section again after a participant's own act on one of these roots. */
  readonly onRequestRead: () => void;
}

/**
 * The execution mode these roots belong to, in the contract's own spelling.
 *
 * TYPED AT THE CONTRACT'S UNION rather than left a free string: `"ephemeral clone"`
 * is that union's own member (`packages/contracts/src/repo.ts`), and a heading
 * spelled by hand would be a second spelling of a closed set the picker beside it
 * renders from — the drift the annotation makes impossible.
 */
export const CLONE_EXECUTION_MODE: ExecutionMode = "ephemeral clone";

/** The clone list's heading, naming the execution mode those roots belong to. */
export const CLONE_LIST_HEADING: string = `Roots for the ${CLONE_EXECUTION_MODE} mode`;

/** What the clone list says before and after the one read that names a clone. */
export const CLONES_NOT_READ_TITLE = "Execution roots have not been read.";

/**
 * The clones this session holds, drawn beside the mounts rather than under one.
 *
 * SESSION-SCOPED, because that is the only anchoring the wire gives them. A clone row
 * names a WORKSPACE (`ephemeral_clones.workspace_id`) where a worktree row names a
 * MOUNT, so a clone reaches a mount only through the roster — and a session whose
 * roster read answered while a mount read did not would then have clones nothing
 * could draw. The list sits at the section, where the read that produced it was made.
 *
 * TWO LISTS WITH DIFFERENT COLUMNS, this section's own split and stated here because
 * it is drawn here. `EphemeralCloneCard` is the second one: the disposal countdown is on
 * the row rather than behind the disclosure, because it is the one fact here that
 * changes with nobody acting.
 *
 * AND EACH CLONE CARRIES ITS OWN CHANGE-PROPOSAL GATE, for the reason the mount card
 * states about the in-place root: a clone is one of the three WRITABLE execution
 * modes, so a list that drew the root and no gate left a participant running in that
 * mode with no way to read a branch context, prepare a proposal, or ask for a reviewed
 * act at all.
 *
 * THIS LIST IS THE ONE PLACE IN THE SECTION WITH A DEADLINE RATHER THAN AN AGE, which
 * is why it holds the hook and the mount list does not. `clone-expiry-wake-up.ts` says
 * what the wake-up is and what it refuses to be; the instant it answers with is the
 * read's own until a disposal time this read did not reach passes.
 */
export function EphemeralCloneList(props: EphemeralCloneListProps): React.JSX.Element {
  const nowMilliseconds = useCloneExpiryInstant(
    props.reading.ephemeralClones,
    props.reading.readAtMilliseconds,
    props.bridge,
  );
  return (
    <div className="meridian-repo-section__clones">
      <h4 className="meridian-repo-section__clones-heading">{CLONE_LIST_HEADING}</h4>
      {renderCloneRows(props, nowMilliseconds)}
    </div>
  );
}

/**
 * The clone rows, or the one absence that stands in for them.
 *
 * A function returning JSX rather than a second component, on `MountCard`'s own
 * `renderRoots` precedent: the branches decide which absence a settled read produced,
 * which is a reading rather than a surface of its own.
 *
 * The subject is resolved HERE, from the roster this same reading carries, because the
 * clone row names its workspace but not that workspace's execution mode — and the mode
 * is what a gate's summary reports the context under. Where the roster names no
 * such workspace the row draws its absence instead, which is the pairing module's rule
 * applied to the one relation this list can be missing.
 */
export function renderCloneRows(
  props: EphemeralCloneListProps,
  nowMilliseconds: number,
): React.JSX.Element {
  const { reading } = props;
  if (reading.ephemeralClones.length > 0) {
    return (
      <>
        {reading.ephemeralClones.map((record) => (
          <EphemeralCloneGateRow
            key={record.cloneId}
            record={record}
            subject={ephemeralCloneGateSubject(record, reading.workspaces)}
            bridge={props.bridge}
            sessionStore={props.sessionStore}
            nowMilliseconds={nowMilliseconds}
            onRequestRead={props.onRequestRead}
          />
        ))}
      </>
    );
  }
  if (reading.status === "reading") {
    return <Nothing kind="computing" placement="surface" title="Reading execution roots." />;
  }
  if (reading.status === "not-read") {
    return <Nothing kind="not-checked" placement="surface" title={CLONES_NOT_READ_TITLE} />;
  }
  if (reading.worktreeRefusal !== undefined) {
    // `not-checked` and never `empty`: the root read is the only read that names a
    // clone, it did not answer, and reporting "there are none" would be the console
    // asserting a fact nothing established. The daemon's own sentence stays where it
    // was refused — on the mount cards above — so it is not printed twice.
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Ephemeral clones have not been read."
        detail="The execution-root read was refused, so which clones this session holds is unknown."
      />
    );
  }
  if (reading.worktreeReadPosition === "not-made") {
    // A DIFFERENT ABSENCE FROM THE ONE ABOVE, and it is the one a settled section can
    // otherwise mistake for `empty`: the workspace list refused, so the burst stopped
    // before the root read and there is no refusal of its own to report. The section's
    // own refusal card names what failed; this says what that leaves unknown.
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title={CLONES_NOT_READ_TITLE}
        detail="The section's read stopped before the execution-root call, so which clones this session holds was never asked."
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="This session holds no ephemeral clone."
      detail="A clone is provisioned when a run selects the ephemeral clone execution mode, and it is disposed on its own schedule — so a session with none has run nothing in that mode."
    />
  );
}
