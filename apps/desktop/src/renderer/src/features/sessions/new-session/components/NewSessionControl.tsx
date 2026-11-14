// The sessions list's one New session control and its picker: `Just chat`, then the recent
// projects. Opening puts the caret on the first row and Escape closes it. A pick makes the session
// at once and opens it; the first message is typed in the opened session's own message box. A
// refused create is said in one line under the rows of the picker that asked, which stays open.

import "./NewSessionControl.css";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { NewSessionControlProps } from "../control-contract.js";
import { refusedCreateLine } from "../create.js";
import { useNewSessionPick } from "../hooks/useNewSessionPick.js";

/** The New session control: a press opens the picker, and a pick makes and opens the session. */
export function NewSessionControl(props: NewSessionControlProps): React.JSX.Element {
  const picker = useNewSessionPick(props);
  return (
    <div className="meridian-new-session">
      <button
        ref={picker.openButtonRef}
        type="button"
        className="meridian-new-session__open"
        aria-expanded={picker.isOpen}
        onClick={picker.toggle}
      >
        New session
      </button>
      {picker.isOpen ? (
        <div
          className="meridian-new-session__picker"
          role="group"
          aria-label="New session"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              picker.close();
            }
          }}
        >
          <PickRow
            rowRef={picker.firstRowRef}
            title="Just chat"
            detail="no repo"
            isHeld={picker.isCreating}
            onPick={() => {
              picker.pick(undefined);
            }}
          />
          {props.recentProjects.length === 0 ? null : (
            <>
              <p className="meridian-new-session__heading">Recent repos</p>
              {props.recentProjects.map((project) => (
                <PickRow
                  key={project.projectId}
                  rowRef={undefined}
                  title={project.name}
                  detail={undefined}
                  isHeld={picker.isCreating}
                  onPick={() => {
                    picker.pick(project);
                  }}
                />
              ))}
            </>
          )}
          {picker.refusal === undefined ? null : (
            <InlineRefusal
              code={picker.refusal.code}
              detail={refusedCreateLine(picker.refusal)}
              attempt={picker.refusal}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row of the picker. Held, not disabled, while a create runs, so focus stays on the row; the
 * single-flight key refuses a second press.
 */
function PickRow(props: {
  readonly rowRef: React.Ref<HTMLButtonElement> | undefined;
  readonly title: string;
  readonly detail: string | undefined;
  readonly isHeld: boolean;
  readonly onPick: () => void;
}): React.JSX.Element {
  return (
    <button
      ref={props.rowRef}
      type="button"
      className="meridian-new-session__row"
      aria-disabled={props.isHeld}
      onClick={props.onPick}
    >
      <span className="meridian-new-session__row-title">{props.title}</span>
      {props.detail === undefined ? null : (
        <span className="meridian-new-session__row-detail">{props.detail}</span>
      )}
    </button>
  );
}
