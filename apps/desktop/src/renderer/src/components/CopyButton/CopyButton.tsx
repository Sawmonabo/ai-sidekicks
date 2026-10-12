/** Where a copy control stands: at rest, or showing how its last press ended. */
export type ClipboardCopyStatus = "rest" | "copied" | "failed";

/** A copy control's state and the press that changes it. */
export interface ClipboardCopy {
  readonly status: ClipboardCopyStatus;
  readonly copy: () => void;
}

/**
 * How a Copy control is drawn: the quiet text control beside what it lifts, or a link in the
 * accent among links, as in a diff's footer.
 */
export type CopyButtonLook = "trigger" | "link";

/** What one Copy control says at rest, the copy it presses, and how it is drawn. */
export interface CopyButtonProps {
  /** What the control reads at rest, such as `Copy` or `Copy as JSON`. */
  readonly label: string;
  readonly clipboardCopy: ClipboardCopy;
  /** The quiet trigger where absent. */
  readonly look?: CopyButtonLook;
}

/**
 * A Copy control. The outcome is reported on the control itself, then the control returns to
 * rest.
 */
export function CopyButton(props: CopyButtonProps): React.JSX.Element {
  const { status, copy } = props.clipboardCopy;
  return (
    <button type="button" className={COPY_BUTTON_CLASSES[props.look ?? "trigger"]} onClick={copy}>
      {status === "rest" ? props.label : OUTCOME_LABELS[status]}
    </button>
  );
}

const COPY_BUTTON_CLASSES: Readonly<Record<CopyButtonLook, string>> = {
  trigger: "meridian-disclosure-trigger",
  link: "meridian-link-button",
};

const OUTCOME_LABELS: Readonly<Record<Exclude<ClipboardCopyStatus, "rest">, string>> = {
  copied: "Copied",
  failed: "Could not copy",
};
