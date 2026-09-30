// The pane harness's region, its two controls, and its count line. Every arm of the harness
// screen renders it, because a driver reads the count line and would wait forever on an arm
// that showed an absence without one. Fixture-only, like the screen it frames.

import type { ReactNode } from "react";

/** The harness region's accessible name — how a driver finds this screen. */
export const PANE_HARNESS_LABEL = "Pane harness";

/** The control that mounts one more instance of the addressed kind. */
export const OPEN_CONTROL_LABEL = "Open a pane";

/** The control that unmounts the newest one. */
export const CLOSE_CONTROL_LABEL = "Close the newest pane";

/** What the harness region shows: the count line, the two controls, and any body children. */
export interface PaneHarnessFrameProps {
  readonly instanceCount: number;
  /** The addressed kind, or absent on an arm that never resolved one. */
  readonly paneKindLabel: string | undefined;
  /** Absent on an arm with nothing to open, which is what disables the control. */
  readonly onOpen?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly children?: ReactNode;
}

/** The harness region with its count line and open and close controls. */
export function PaneHarnessFrame(props: PaneHarnessFrameProps): React.JSX.Element {
  const { instanceCount, paneKindLabel, onOpen, onClose, children } = props;
  return (
    <section aria-label={PANE_HARNESS_LABEL}>
      <p>
        {/* The line a driver waits on: the addressed kind and how many are mounted. */}
        {`${paneKindLabel ?? "no"} panes open: ${String(instanceCount)}`}
      </p>
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={() => {
          onOpen?.();
        }}
      >
        {OPEN_CONTROL_LABEL}
      </button>
      <button
        type="button"
        disabled={onClose === undefined || instanceCount === 0}
        onClick={() => {
          onClose?.();
        }}
      >
        {CLOSE_CONTROL_LABEL}
      </button>
      {children}
    </section>
  );
}
