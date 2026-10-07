import { useCallback, useEffect, useRef } from "react";

/** What an inline confirm's group element takes: its ref and its key handler. */
export interface InlineConfirmBinding {
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly onKeyDown: (event: React.KeyboardEvent) => void;
}

/** Which of the confirm's enabled buttons takes focus when it opens. */
export type InlineConfirmFocus = "first-button" | "last-button";

/**
 * A confirm drawn in place of the control that opened it. It takes focus when it opens, on its
 * first enabled button unless `focusOn` names its last, so the next key reaches it; Escape closes
 * it as its `Cancel` does, first in the screen's Escape order, and nothing behind it hears that
 * press.
 */
export function useInlineConfirm(
  onCancel: () => void,
  focusOn: InlineConfirmFocus = "first-button",
): InlineConfirmBinding {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    const target = focusOn === "first-button" ? buttons?.[0] : buttons?.[buttons.length - 1];
    target?.focus();
  }, [focusOn]);
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
