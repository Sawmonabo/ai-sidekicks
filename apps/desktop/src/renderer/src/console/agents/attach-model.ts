// The attach form's state: two arms of one form, and a per-field override mark.
//
// `Spec-023 §Console Design (Meridian)` §Attaching a sidekick makes this a FORM and
// not a wizard, and the shape of the request is what forces that: the union refuses
// exactly one thing, a request naming neither a definition nor a driver-and-model
// pair. Everything else is a field.
//
// TWO MEMBERS ARE REQUIRED ON BOTH ARMS — the session the agent joins and the name it
// is called by — because the registered request base requires them of every arm. They
// are not axes and neither is definition-resolved, so neither joins the override
// machinery below: the session is bound by the caller and the name is typed.
//
// THE OVERRIDE MARK IS THE POINT OF THE DEFINITION ARM. An explicitly present member
// wins FOR THAT FIELD ONLY, so the form pre-fills from the definition and sends only
// what the caller actually edited. That is why this class tracks presence rather
// than value equality: a caller who retypes the definition's own value has still
// explicitly said it, and a form that compared strings would silently drop that from
// the request and change what the daemon resolves.
//
// WHAT IT DOES NOT DO. It never substitutes a default for a pinned account that has
// gone missing — that would convert a legible refusal into a silent change of who
// pays — and it carries no `outputSpeed` field at all, because an agent is not born
// with a speed mode.
//
// A CLASS WITH PRIVATE FIELDS, not a hook body: it holds edited state and an
// emitter, and `apps/desktop/AGENTS.md` puts stateful logic here rather than in a
// render.

import { Emitter, type Unsubscribe } from "../core/index.js";
import type { SidekickDefinitionSummary } from "./agent-wire.js";

/** Which arm the caller is filling. The definition arm needs only an id. */
export const ATTACH_ARMS = ["definition", "inline"] as const;
export type AttachArm = (typeof ATTACH_ARMS)[number];

/** The four fields either arm may carry. `outputSpeed` is deliberately not one. */
export const ATTACH_FIELDS = ["driverName", "modelId", "providerAccountId", "effort"] as const;
export type AttachField = (typeof ATTACH_FIELDS)[number];

/**
 * What the form would send, once it is complete.
 *
 * `sessionId` and `name` are required on BOTH arms because the registered request
 * base requires them, and a request missing either is refused by any conforming
 * daemon whatever else it carries. The session is not the form's to know — it is
 * bound by the caller at {@link AttachSidekickForm.readiness} — and the name is the
 * AGENT's rather than the definition's, which is why no arm ever fills it in.
 */
export interface AttachRequest {
  readonly sessionId: string;
  readonly name: string;
  readonly definitionId?: string | undefined;
  readonly driverName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerAccountId?: string | undefined;
  readonly effort?: string | undefined;
}

export type AttachReadiness =
  | { readonly status: "ready"; readonly request: AttachRequest }
  | { readonly status: "incomplete"; readonly missing: readonly string[] };

export class AttachSidekickForm {
  readonly #changes = new Emitter<void>("attach form");
  #arm: AttachArm = "inline";
  #definition: SidekickDefinitionSummary | undefined;
  #entered = new Map<AttachField, string>();
  #name = "";

  /** Subscribe to edits. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  public get arm(): AttachArm {
    return this.#arm;
  }

  public get definition(): SidekickDefinitionSummary | undefined {
    return this.#definition;
  }

  /** What the agent will be called. Its own field, on neither arm's merge path. */
  public get name(): string {
    return this.#name;
  }

  /**
   * Name the agent.
   *
   * Never pre-filled from the chosen definition. The daemon resolves nothing for
   * this member — a definition's name is the DEFINITION's — so a value put here by
   * the form would be the console asserting a choice nobody made.
   */
  public setName(value: string): void {
    if (this.#name === value) {
      return;
    }
    this.#name = value;
    this.#changes.emit();
  }

  /**
   * Move to an arm.
   *
   * Entered values survive the move on purpose: a caller who typed a model and then
   * discovered a definition should not lose it, and the readiness check below is
   * what decides which of them the request carries.
   */
  public selectArm(arm: AttachArm): void {
    if (this.#arm === arm) {
      return;
    }
    this.#arm = arm;
    this.#changes.emit();
  }

  /**
   * Choose the definition the definition arm resolves through.
   *
   * Choosing a different one drops every override, because an override is a claim
   * about a specific definition's field and carrying it across would silently apply
   * it to a value the caller never saw.
   */
  public selectDefinition(definition: SidekickDefinitionSummary | undefined): void {
    this.#definition = definition;
    this.#entered = new Map();
    this.#arm = definition === undefined ? this.#arm : "definition";
    this.#changes.emit();
  }

  /** Type into one field. An empty string clears the entry rather than sending one. */
  public setField(field: AttachField, value: string): void {
    if (value === "") {
      this.#entered.delete(field);
    } else {
      this.#entered.set(field, value);
    }
    this.#changes.emit();
  }

  /** Drop an override, returning the field to whatever the definition supplies. */
  public clearOverride(field: AttachField): void {
    if (!this.#entered.has(field)) {
      return;
    }
    this.#entered.delete(field);
    this.#changes.emit();
  }

  /**
   * Whether the caller edited this field.
   *
   * Presence, never value equality — see the header. On the inline arm every entered
   * field is simply the value, so nothing is marked as overriding anything.
   */
  public isOverridden(field: AttachField): boolean {
    return this.#arm === "definition" && this.#entered.has(field);
  }

  /** What the field shows: the entry where there is one, else the definition's value. */
  public effectiveValue(field: AttachField): string | undefined {
    const entered = this.#entered.get(field);
    if (entered !== undefined) {
      return entered;
    }
    if (this.#arm !== "definition") {
      return undefined;
    }
    return this.#definition?.[field];
  }

  /**
   * The request, or what is still missing.
   *
   * The definition arm sends the id plus ONLY the fields the caller entered, which is
   * what makes the merge per-field at the daemon rather than a whole-record replace
   * composed here.
   *
   * The session is an ARGUMENT rather than a field: this form is opened over whatever
   * session the surface is showing, and a copy held here would be a second answer to
   * a question the models already own.
   */
  public readiness(sessionId: string): AttachReadiness {
    const name = this.#name.trim();
    const missing: string[] = [];
    if (name === "") {
      missing.push("a name");
    }
    if (this.#arm === "definition") {
      const definitionId = this.#definition?.definitionId;
      if (definitionId === undefined) {
        missing.push("a definition");
      }
      if (name === "" || definitionId === undefined) {
        return { status: "incomplete", missing };
      }
      return {
        status: "ready",
        request: {
          sessionId,
          name,
          definitionId,
          driverName: this.#entered.get("driverName"),
          modelId: this.#entered.get("modelId"),
          providerAccountId: this.#entered.get("providerAccountId"),
          effort: this.#entered.get("effort"),
        },
      };
    }
    const driverName = this.#entered.get("driverName");
    const modelId = this.#entered.get("modelId");
    if (driverName === undefined) {
      missing.push("a driver");
    }
    if (modelId === undefined) {
      missing.push("a model");
    }
    if (name === "" || driverName === undefined || modelId === undefined) {
      return { status: "incomplete", missing };
    }
    return {
      status: "ready",
      request: {
        sessionId,
        name,
        driverName,
        modelId,
        providerAccountId: this.#entered.get("providerAccountId"),
        effort: this.#entered.get("effort"),
      },
    };
  }
}
