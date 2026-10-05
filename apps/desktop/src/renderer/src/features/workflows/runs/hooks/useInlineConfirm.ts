import { useCallback, useEffect, useRef } from "react";

/** What an inline confirm's group element takes: its ref and its key handler. */
export interface InlineConfirmBinding {
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * A confirm drawn in place of the control that opened it. It takes focus when it opens, on its
 * first button, so the next key reaches it; Escape closes it as its `Cancel` does, first in the
 * screen's Escape order, and nothing behind it hears that press.
 */
export function useInlineConfirm(onCancel: () => void): InlineConfirmBinding {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    },
    [onCancel],
  );
  return { ref, onKeyDown };
}
