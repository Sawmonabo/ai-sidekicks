import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { McpRegistryInput } from "@ai-sidekicks/contracts/mcp/server";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { takeWriteOnlyValue } from "#renderer/features/settings/write-only-field.js";
import type { HeldPairValues } from "../held-pair-values.js";

/** The two kinds of name-and-value pair a server declaration carries. */
type McpPairKind = "environment" | "headers";

/** What a pair's `Add` settles with once its name is added. */
const NAME_ADDED_WORDS =
  "That name was added. Its value is held only long enough to send and is never read back.";

/** Each kind's heading and the names its name and value fields are read out by. */
const PAIR_WORDS: Readonly<
  Record<McpPairKind, { readonly heading: string; readonly name: string; readonly value: string }>
> = {
  environment: {
    heading: "Environment variables",
    name: "Environment variable name",
    value: "Environment variable value",
  },
  headers: { heading: "Headers", name: "Header name", value: "Header value" },
};

/**
 * Name-and-value pairs of one kind (`Environment variables`, `Headers`): a row for each name the
 * form asks for, with what it is for and `Required` where the server needs it, then one blank row
 * for a name of the person's own. Each row's `Add` hands its value to `heldValues`, clears the
 * masked value field in the same step and settles in place; a row typed whole and never added is
 * read by `heldValues` when the form is sent. A row with only its name or only its value typed
 * holds the form's submit, as any other field the form needs does, and so does an asked name the
 * server needs whose value is empty; a name of spaces alone is no name.
 */
export function NameValuePairs(props: {
  readonly kind: McpPairKind;
  /** The names asked for, as a registry result names them. */
  readonly askedNames: readonly McpRegistryInput[];
  /** The names whose value the form holds, in the order they were added. */
  readonly addedNames: readonly string[];
  /** Where each row's value goes, and what reads the rows when the form is sent. */
  readonly heldValues: HeldPairValues;
  readonly onNameAdded: (name: string) => void;
}): ReactNode {
  const { kind, askedNames, addedNames, heldValues, onNameAdded } = props;
  const words = PAIR_WORDS[kind];
  const headingId = useId();
  const ownNames = addedNames.filter((name) => !askedNames.some((asked) => asked.name === name));
  const onAdd = (name: string, value: string): void => {
    heldValues.add(name, value);
    onNameAdded(name);
  };
  return (
    <div className="meridian-mcp__pairs" role="group" aria-labelledby={headingId}>
      <span id={headingId} className="meridian-form__label">
        {words.heading}
      </span>
      {askedNames.map((asked) =>
        addedNames.includes(asked.name) ? (
          <AddedPair key={asked.name} name={asked.name} />
        ) : (
          <PairRow
            key={asked.name}
            asked={asked}
            kind={kind}
            heldValues={heldValues}
            onAdd={onAdd}
          />
        ),
      )}
      {ownNames.map((name) => (
        <AddedPair key={name} name={name} />
      ))}
      <PairRow asked={undefined} kind={kind} heldValues={heldValues} onAdd={onAdd} />
    </div>
  );
}

// A name with its masked value field and `Add`: an asked name drawn as it is named, with what it
// is for, or a name field for one of the person's own. A press on `Add` reads the value once and
// clears its field before handing it on; the form's send reads and clears both fields the same
// way. Whether the value field holds anything is all the row keeps of it.
function PairRow(props: {
  readonly asked: McpRegistryInput | undefined;
  readonly kind: McpPairKind;
  readonly heldValues: HeldPairValues;
  readonly onAdd: (name: string, value: string) => void;
}): ReactNode {
  const { asked, kind, heldValues, onAdd } = props;
  const words = PAIR_WORDS[kind];
  const [ownName, setOwnName] = useState("");
  const [isValueTyped, setIsValueTyped] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const askedNameId = useId();
  const aboutId = useId();
  useEffect(
    () =>
      heldValues.watch({
        take: () => {
          const name = asked?.name ?? nameInput.current?.value.trim() ?? "";
          const value = takeWriteOnlyValue(valueInput.current);
          setOwnName("");
          setIsValueTyped(false);
          return name === "" || value === "" ? undefined : { name, value };
        },
      }),
    [heldValues, asked],
  );
  const name = asked === undefined ? ownName.trim() : asked.name;
  const about = [asked?.isRequired === true ? "Required" : undefined, asked?.description]
    .filter((line): line is string => line !== undefined && line !== "")
    .join(" · ");
  return (
    <div className="meridian-mcp__pair">
      {asked === undefined ? (
        <input
          ref={nameInput}
          className="meridian-form__input meridian-form__input--wire"
          type="text"
          placeholder="Name"
          aria-label={words.name}
          required={isValueTyped}
          autoComplete="off"
          spellCheck={false}
          value={ownName}
          onChange={(event) => {
            // Spaces alone are held as no name, so the field reads empty to the form's check.
            const typed = event.currentTarget.value;
            setOwnName(typed.trim() === "" ? "" : typed);
          }}
        />
      ) : (
        <span id={askedNameId}>
          <WireFigure value={asked.name} />
        </span>
      )}
      <input
        ref={valueInput}
        className="meridian-form__input"
        type="password"
        placeholder="Value"
        aria-label={words.value}
        aria-describedby={
          asked === undefined
            ? undefined
            : [askedNameId, ...(about === "" ? [] : [aboutId])].join(" ")
        }
        required={asked === undefined ? name !== "" : asked.isRequired}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setIsValueTyped(event.currentTarget.value !== "");
        }}
      />
      <button
        type="button"
        className="meridian-settings-page__action meridian-action-button"
        disabled={name === ""}
        onClick={() => {
          onAdd(name, takeWriteOnlyValue(valueInput.current));
          setOwnName("");
          setIsValueTyped(false);
        }}
      >
        Add
      </button>
      {about === "" ? null : (
        <span id={aboutId} className="meridian-mcp__pair-about meridian-settings-page__aside">
          {about}
        </span>
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
