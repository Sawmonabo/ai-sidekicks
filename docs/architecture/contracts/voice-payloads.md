# Voice Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Voice Method Registry (Plan-003)

Talking instead of typing, on both providers, with the same keys: `/voice` turns voice on in the session it is typed in, and holding Space (or, after `/voice tap`, tapping it) talks. Voice is on in one session at a time on this computer; the daemon holds which, so every window and device showing that session shows the same, and it is off after the daemon restarts. What each provider does with the words differs:

- **Claude Code: dictation into the draft.** The window captures the microphone, cuts it to 16 kHz 16-bit mono and hands the frames to the daemon, which runs its own socket to Anthropic's speech service, one per recording, signed in with the session's account, and relays the words back. Dictation never passes through Claude Code, so no other Claude Code session hears it.
- **Codex: Codex's own spoken call.** The window is the call's WebRTC peer. The daemon passes the window's offer in `thread/realtime/start` on the account's Codex service and returns Codex's answer from `thread/realtime/sdp`, routes Codex's `thread/realtime/*` notifications to the call by `threadId`, and, when a turn that answers a spoken message ends, sends its final answer to `thread/realtime/appendSpeech`, cut at 990 tokens, so the voice speaks it. A call belongs to the one conversation it is started on.

The mode (hold or tap, one for both providers) and the call voice are keys in the machine's settings file, `voice.mode` (`hold` or `tap`, default `hold`) and `voice.callVoice` (the voice a spoken call answers in; only Codex's call speaks today, and `voice.voiceList` gives the choices; missing reads as Codex's default), read and written through the preload bridge's `machineSettings.read()` / `machineSettings.write(change)` ([§Settings Surface Reads And Writes](./settings-payloads.md#settings-surface-reads-and-writes)). No method here carries the mode, and nothing is written into either provider's own configuration. From another device the device in hand is the microphone: dictation's frames reach the machine over the encrypted relay, and a call's offer and answer pass through the machine. The speech socket and `thread/realtime/appendSpeech` are the daemon's own, and no client calls them.

There is one recording and one call at a time on this computer, so the verbs on the one in progress name no session; the frames they stream still carry it.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `voice.stateUpdate` | `mutation` | `VoiceState` | `VoiceState` |
| `voice.stateSubscribe` | `subscription` | `EmptyPayload` | `VoiceState` (stream) |
| `voice.dictationStart` | `mutation` | `VoiceDictationStartRequest` | `EmptyPayload` |
| `voice.dictationWrite` | `mutation` | `VoiceDictationWriteRequest` | `EmptyPayload` |
| `voice.dictationStop` | `mutation` | `VoiceDictationStopRequest` | `EmptyPayload` |
| `voice.dictationSubscribe` | `subscription` | `EmptyPayload` | `VoiceDictationFrame` (stream) |
| `voice.callStart` | `mutation` | `VoiceCallStartRequest` | `VoiceCallStartResponse` |
| `voice.callStop` | `mutation` | `EmptyPayload` | `EmptyPayload` |
| `voice.callSubscribe` | `subscription` | `EmptyPayload` | `VoiceCallFrame` (stream) |
| `voice.voiceList` | `query` | `EmptyPayload` | `VoiceListResponse` |

Voice on an account its provider gives no voice (on Claude Code, an account that is neither a Claude sign-in nor a pasted Claude token) is refused with `voice.unavailable`, whose details are `{reason: "provider_sign_in_required", provider}` so the screen draws that provider's own sentence and remedy. `voice.callStart` refuses with `voice.call_start_failed` when Codex could not start the call.

```ts
// Which session voice is on in, or null when it is off: the request of `voice.stateUpdate`, its
// result, and each delivery of `voice.stateSubscribe`, the first of which is the current state.
// Moving it ends the other session's call, and `Voice ended` lands there.
interface VoiceState {
  sessionId: SessionId | null;
}

// Dictation, on a Claude Code session. The request carries no mode: hold or tap is the window's,
// read from the machine's settings file, and the socket runs the same in both.
interface VoiceDictationStartRequest {
  sessionId: SessionId;
}
// One frame of the recording's audio: standard base64 of 16 kHz 16-bit mono PCM, at most 100 ms
// (3,200 bytes) and whole 16-bit samples, because the local wire carries JSON and no binary member.
// 600 frames a minute, about 32 KB a second.
interface VoiceDictationWriteRequest {
  audio: string;
}
// Ends the recording. `cancel: true` is Escape's: the recording is dropped and its words with it.
interface VoiceDictationStopRequest {
  cancel: boolean;
}
// One push of the dictation stream. The speech service's in-progress words replace `inProgress`,
// and its settling of them moves them into `committed`; the draft shows the committed words, a
// space, then the words in progress, dimmed until they settle. `ended` closes the recording, with
// its failure or null.
type VoiceDictationFrame =
  | { kind: "words"; sessionId: SessionId; committed: string; inProgress: string }
  | { kind: "ended"; sessionId: SessionId; failure: VoiceDictationFailure | null };

// Why a recording ended without its words, each drawn as the strip's one-line refusal. Refusals
// about the microphone itself are the window's own.
type VoiceDictationFailure =
  // `No sound reached the microphone. Check the input device.`: only silent samples reached it.
  | { reason: "no_sound" }
  // `No speech heard.`: the recording closed having heard sound but no words.
  | { reason: "no_speech" }
  // `Dictation couldn't be sent.` with `Try again`: the connection failed after the one retry, or
  // the service refused with a 4xx other than 401 or 403.
  | { reason: "not_sent" }
  // `Dictation couldn't sign in to <account>.` with `Sign in again`: the service refused the
  // account's sign-in (401 or 403).
  | { reason: "sign_in_refused" }
  // The speech service's own error, in its own words.
  | { reason: "service_error"; message: string };

// A Codex call, started at the first hold or tap of Space once voice is on there. The daemon passes
// the offer in `thread/realtime/start` with the voice picked in the machine's settings file and the
// session's earlier spoken exchange, and returns Codex's answer.
interface VoiceCallStartRequest {
  sessionId: SessionId;
  offerSdp: string; // non-empty
}
interface VoiceCallStartResponse {
  answerSdp: string; // non-empty
}
// `voice.callStop` takes `EmptyPayload`, sent once the window has closed the call: when voice
// is turned off or moves to another session.
// One push of the call stream: the call started; the words the call hears from the person as they
// arrive, then settled; the voice's reply, settled; the call ended, with its cause.
type VoiceCallFrame =
  | { kind: "started"; sessionId: SessionId }
  | { kind: "userTranscriptDelta"; sessionId: SessionId; delta: string }
  | { kind: "userTranscriptDone"; sessionId: SessionId; text: string }
  | { kind: "assistantTranscriptDone"; sessionId: SessionId; text: string }
  | ({ kind: "ended"; sessionId: SessionId } & VoiceCallEndCause);
// Why a call ended: the daemon stopped it, Codex closed it with its own reason or none, or Codex
// reported an error in its own words.
type VoiceCallEndCause =
  | { cause: "stopped" }
  | { cause: "closed"; reason: string | null }
  | { cause: "error"; message: string }; // non-empty

// The voices Codex offers a call (its own `v1` list) and the one it uses until the person picks
// another, for `/voice settings`. The pick is written to the machine's settings file, never into
// Codex's configuration.
interface VoiceListResponse {
  voices: string[]; // each non-empty
  defaultVoice: string; // non-empty
}
```
