// An inline confirm takes focus as it opens, on its first enabled button or its last, so the next
// key reaches it, and Escape closes it as its `Cancel` does before anything behind it hears the
// key; every other key, and an Escape a control inside it already answered, pass on untouched.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInlineConfirm, type InlineConfirmFocus } from "./useInlineConfirm.js";

afterEach(cleanup);

function ConfirmProbe(props: {
  readonly onCancel: () => void;
  readonly focusOn?: InlineConfirmFocus;
}): React.JSX.Element {
  const confirm = useInlineConfirm(props.onCancel, props.focusOn);
  return (
    <div ref={confirm.ref} role="group" aria-label="Delete this run?" onKeyDown={confirm.onKeyDown}>
      <button type="button" disabled>
        Keep
      </button>
      <button type="button">Cancel</button>
      <input
        aria-label="Older than"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
          }
        }}
      />
      <button type="button">Delete</button>
      <button type="button" disabled>
        Archive
      </button>
    </div>
  );
}

describe("an inline confirm", () => {
  it("focuses its first enabled button as it opens, or its last when asked", () => {
    const first = render(<ConfirmProbe onCancel={() => undefined} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    first.unmount();

    render(<ConfirmProbe onCancel={() => undefined} focusOn="last-button" />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
  });

  it("closes on Escape before the screen behind it hears the key, and passes every other key on", () => {
    const onCancel = vi.fn();
    const screenKeys: string[] = [];
    render(
      <div
        onKeyDown={(event) => {
          screenKeys.push(event.key);
        }}
      >
        <ConfirmProbe onCancel={onCancel} />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screenKeys).toStrictEqual([]);

    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Enter" });
    // A control inside the confirm that answers Escape itself keeps the confirm open.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Older than" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screenKeys).toStrictEqual(["Enter", "Escape"]);
  });
});
