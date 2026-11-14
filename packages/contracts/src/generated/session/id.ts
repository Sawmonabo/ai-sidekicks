// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The ids a session's contracts carry: the session, the person, and the event cursor, with the cursor's refusal code and the position before a session's first event.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";

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
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link SessionId}. */
// prettier-ignore
export const validateSessionId: CompiledSchemaCheck<SessionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateSessionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateSessionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateSessionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link UserId}. */
// prettier-ignore
export const validateUserId: CompiledSchemaCheck<UserId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is UserId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateUserId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateUserId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateUserId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateUserId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateUserId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link EventCursor}. */
// prettier-ignore
export const validateEventCursor: CompiledSchemaCheck<EventCursor> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is EventCursor {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateEventCursor.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) > 256){validateEventCursor.errors = [{instancePath,schemaPath:"#/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data) < 1){validateEventCursor.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateEventCursor.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateEventCursor.errors = vErrors;return errors === 0;};
// prettier-ignore
validateEventCursor.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
