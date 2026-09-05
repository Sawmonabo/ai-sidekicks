import { Chip, WireFigure } from "../../primitives/index.js";
import { type ChildRunLink } from "../../bridge/index.js";
import { CHILD_RUN_LINK_TYPES, CHILD_RUN_VISIBILITIES, isKnownMember } from "../agent-wire.js";

/**
 * One child link.
 *
 * An `internalHelper` row is de-emphasized and NEVER ejected: it stays in audit
 * history, and a list that dropped it would answer "what did this run start" with a
 * partial truth.
 */
export function ChildLinkRow(props: {
  readonly link: ChildRunLink;
  readonly onOpen?: ((childRunId: string) => void) | undefined;
}): React.JSX.Element {
  const { link } = props;
  const meaning = isKnownMember(CHILD_RUN_LINK_TYPES, link.linkType)
    ? LINK_TYPE_MEANINGS[link.linkType]
    : undefined;
  return (
    <li
      className={`meridian-linkage__link${link.internalHelper ? " meridian-linkage__link--helper" : ""}`}
    >
      <span className="meridian-linkage__link-head">
        <Chip tone="neutral" mono label={link.linkType} />
        {props.onOpen === undefined ? (
          <WireFigure value={link.childRunId} />
        ) : (
          <button
            type="button"
            className="meridian-linkage__open"
            onClick={() => props.onOpen?.(link.childRunId)}
          >
            <WireFigure value={link.childRunId} />
          </button>
        )}
        {link.internalHelper ? <Chip tone="neutral" label="internal helper" /> : null}
      </span>
      <span className="meridian-linkage__link-meaning">
        {meaning ?? "a relationship this console does not know by name"}
      </span>
      <span className="meridian-linkage__link-state">
        {/* Anything that is not `reachable` takes the last-known treatment, including a
            member this console does not know: reading an unrecognized visibility as
            reachable would present a stale state as a live one, which is the one wrong
            answer on this axis. A known member is a caution; an unknown one is quoted. */}
        {link.visibility === "reachable" ? (
          link.state === undefined ? null : (
            <WireFigure value={link.state} />
          )
        ) : (
          <>
            <Chip
              tone={
                isKnownMember(CHILD_RUN_VISIBILITIES, link.visibility) ? "attention" : "neutral"
              }
              mono
              label={link.visibility}
            />
            <span className="meridian-linkage__last-known">
              Last known state{link.state === undefined ? " was not reported" : ": "}
              {link.state === undefined ? null : <WireFigure value={link.state} />}. This is a
              visibility outcome, not a run-state transition.
            </span>
          </>
        )}
      </span>
    </li>
  );
}

export const LINK_TYPE_MEANINGS: Readonly<Record<string, string>> = {
  spawn: "a helper this run started; its output returns here",
  delegate: "a bounded task published to its own channel",
  handoff: "this run's continuation, transferred; the parent completed",
};
