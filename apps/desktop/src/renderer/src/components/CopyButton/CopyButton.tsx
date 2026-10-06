/** Where a copy control stands: at rest, or showing how its last press ended. */
export type ClipboardCopyStatus = "rest" | "copied" | "failed";

/** A copy control's state and the press that changes it. */
export interface ClipboardCopy {
  readonly status: ClipboardCopyStatus;
  readonly copy: () => void;
}

/** What one Copy control says at rest and the copy it presses. */
export interface CopyButtonProps {
  /** What the control reads at rest, such as `Copy` or `Copy as JSON`. */
  readonly label: string;
  readonly clipboardCopy: ClipboardCopy;
}

/**
 * A Copy control. The outcome is reported on the control itself, then the control returns to
 * rest.
 */
export function CopyButton(props: CopyButtonProps): React.JSX.Element {
  const { status, copy } = props.clipboardCopy;
  return (
    <button type="button" className="meridian-disclosure-trigger" onClick={copy}>
      {status === "rest" ? props.label : OUTCOME_LABELS[status]}
    </button>
  );
}

const OUTCOME_LABELS: Readonly<Record<Exclude<ClipboardCopyStatus, "rest">, string>> = {
  copied: "Copied",
  failed: "Could not copy",
};
