/** How a workflows action button stands out: outlined, filled with the accent, or raised. */
export type ActionButtonTone = "outline" | "primary" | "raised";

/**
 * The workflows screen's small action button, in the app's shared action-button treatment. It is
 * a plain `type="button"` unless it submits a form; `className` adds the caller's own layout.
 */
export function ActionButton(
  props: Omit<React.ComponentPropsWithoutRef<"button">, "type"> & {
    readonly tone?: ActionButtonTone;
    readonly type?: "button" | "submit";
  },
): React.JSX.Element {
  const { tone = "outline", type = "button", className, ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      type={type}
      className={
        `meridian-action-button meridian-action-button--small ${TONE_CLASSES[tone]}` +
        (className === undefined ? "" : ` ${className}`)
      }
    />
  );
}

const TONE_CLASSES: Record<ActionButtonTone, string> = {
  outline: "meridian-action-button--outline",
  primary: "meridian-accent-fill",
  raised: "meridian-action-button--raised",
};
