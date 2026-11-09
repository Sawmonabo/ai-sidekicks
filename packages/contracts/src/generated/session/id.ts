// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ids a session's contracts carry: the session, the person, and the event cursor, with the cursor's refusal code and the position before a session's first event.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";

/** The refusal for an event cursor that names no position in its session's log. */
export const SESSION_EVENT_CURSOR_UNRESOLVABLE_CODE = "session.event.cursorUnresolvable" as const;

/** The log position before a session's first event, where a read of the whole log starts. */
export const START_OF_LOG_POSITION = -1 as const;

/**
 * Identifies one session.
 */
export type SessionId = string & { readonly __brand: "SessionId" };
/**
 * Identifies one person.
 */
export type UserId = string & { readonly __brand: "UserId" };
/**
 * An opaque position in a session's event log, passed through unchanged. Its format belongs
 * to the daemon, which writes it with `encode_event_cursor`.
 */
export type EventCursor = string & { readonly __brand: "EventCursor" };

// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1969(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventCursor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1969.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validate1969.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validate1969.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1969.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1969.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1969.errors = null as any[] | null;
// prettier-ignore
validate1969.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1970(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1970.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern4.test(data)){validate1970.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1970.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validate1970.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1970.errors = null as any[] | null;
// prettier-ignore
validate1970.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link EventCursor}. */
export const validateEventCursor: SchemaCheck<EventCursor> = validate1969;
/** Checks that a value is a {@link SessionId}. */
export const validateSessionId: SchemaCheck<SessionId> = validate1970;
