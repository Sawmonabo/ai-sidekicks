import { useId, useRef, useState, type ReactNode } from "react";

import type { McpRegistryInput } from "@ai-sidekicks/contracts/mcp/server";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { takeWriteOnlyToken } from "../../providers/sign-in/flow.js";

/** What a pair's `Add` settles with once its name is added. */
const NAME_ADDED_WORDS =
  "That name was added. Its value is held only long enough to send and is never read back.";

/**
 * Name-and-value pairs under one heading (`Environment variables`, `Headers`): a row for each name
 * the form asks for, with what it is for and `Required` where the server needs it, then one blank
 * row for a name of the person's own. Each row's `Add` hands its name and value to `onAdd`, clears
 * the masked value field in the same step and settles in place; the value is never held here.
 */
export function NameValuePairs(props: {
  readonly heading: string;
  /** The names asked for, as a registry result names them. */
  readonly askedNames: readonly McpRegistryInput[];
  /** The names whose value the form holds, in the order they were added. */
  readonly addedNames: readonly string[];
  readonly onAdd: (name: string, value: string) => void;
}): ReactNode {
  const { heading, askedNames, addedNames, onAdd } = props;
  const headingId = useId();
  const ownNames = addedNames.filter((name) => !askedNames.some((asked) => asked.name === name));
  return (
    <div className="meridian-mcp__pairs" role="group" aria-labelledby={headingId}>
      <span id={headingId} className="meridian-form__label">
        {heading}
      </span>
      {askedNames.map((asked) =>
        addedNames.includes(asked.name) ? (
          <AddedPair key={asked.name} name={asked.name} />
        ) : (
          <PairRow key={asked.name} asked={asked} onAdd={onAdd} />
        ),
      )}
      {ownNames.map((name) => (
        <AddedPair key={name} name={name} />
      ))}
      <PairRow asked={undefined} onAdd={onAdd} />
    </div>
  );
}

// A name with its masked value field and `Add`: an asked name drawn as it is named, with what it
// is for, or a name field for one of the person's own. A press on `Add` reads the value once and
// clears its field before handing it on.
function PairRow(props: {
  readonly asked: McpRegistryInput | undefined;
  readonly onAdd: (name: string, value: string) => void;
}): ReactNode {
  const { asked, onAdd } = props;
  const [ownName, setOwnName] = useState("");
  const valueInput = useRef<HTMLInputElement>(null);
  const name = asked === undefined ? ownName.trim() : asked.name;
  const about = [asked?.isRequired === true ? "Required" : undefined, asked?.description]
    .filter((words): words is string => words !== undefined && words !== "")
    .join(" · ");
  return (
    <div className="meridian-mcp__pair">
      {asked === undefined ? (
        <input
          className="meridian-form__input meridian-form__input--wire"
          type="text"
          placeholder="Name"
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          value={ownName}
          onChange={(event) => {
            setOwnName(event.currentTarget.value);
          }}
        />
      ) : (
        <WireFigure value={asked.name} />
      )}
      <input
        ref={valueInput}
        className="meridian-form__input"
        type="password"
        placeholder="Value"
        aria-label={asked === undefined ? "Value" : `${asked.name} value`}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        disabled={name === ""}
        onClick={() => {
          onAdd(name, takeWriteOnlyToken(valueInput.current));
          setOwnName("");
        }}
      >
        Add
      </button>
      {about === "" ? null : (
        <span className="meridian-mcp__pair-about meridian-settings-page__aside">{about}</span>
      )}
    </div>
  );
}

// A name whose value the form holds: the name, and the line its `Add` settled with.
function AddedPair(props: { readonly name: string }): ReactNode {
  return (
    <div className="meridian-mcp__pair">
      <WireFigure value={props.name} />
      <AnnouncedLine
        element="p"
        className="meridian-settings-page__state"
        words={NAME_ADDED_WORDS}
        politeness="polite"
      />
    </div>
  );
}
