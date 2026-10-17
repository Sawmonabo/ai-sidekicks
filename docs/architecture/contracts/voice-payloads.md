# Voice Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Voice Method Registry (Plan-003)

Talking instead of typing, on Claude Code and on Codex, with the same keys: `/voice` turns voice on in the session it is typed in, and holding Space (or, after `/voice tap`, tapping it) talks. Voice is on in one session at a time on this computer; the daemon holds which, so every window and device showing that session shows the same, and it is off after the daemon restarts. Which of the two ways below a session uses is its provider driver's own fact, carried in the session's provider state as `dictation` or `call`, so a client calls the matching methods without naming a provider. What each provider does with the words differs:

- **Claude Code: dictation into the draft.** The window captures the microphone, cuts it to 16 kHz 16-bit mono and hands the frames to the daemon, which runs its own socket to Anthropic's speech service, one per recording, signed in with the session's account, and relays the words back. Dictation never passes through Claude Code, so no other Claude Code session hears it.
- **Codex: Codex's own spoken call.** The window is the call's WebRTC peer. The daemon passes the window's offer in `thread/realtime/start` on the account's Codex service and returns Codex's answer from `thread/realtime/sdp`, routes Codex's `thread/realtime/*` notifications to the call by `threadId`, and, when a turn that answers a spoken message ends, sends its final answer to `thread/realtime/appendSpeech`, cut at 990 tokens, so the voice speaks it. A call belongs to the one conversation it is started on.

The mode, the call voice and the dictation language are keys in the machine's settings file, read and written through the preload bridge's `machineSettings.read()` / `machineSettings.write(change)` ([§Settings Surface Reads And Writes](./settings-payloads.md#settings-surface-reads-and-writes)):

- `voice.mode`: `hold` or `tap`, one for every provider, default `hold`.
- `voice.callVoice`: the voice a spoken call answers in, picked on the `Voice` row of Settings › Providers › Codex, under the line `Applies from the next call.`, whose choices `voice.list` gives. Missing, the call takes Codex's own `realtime.voice` where the person's Codex settings set one, and Codex's default where they do not; a pick is sent as `voice` on each `thread/realtime/start`, so it applies from the next call.
- `voice.dictationLanguage`: the language dictation sends, picked on the `Dictation language` row of Settings › Providers › Claude Code, under the line `Also the language Claude Code replies in. Applies to sessions started later.`. Missing, it follows Claude Code's own `language` as the person's Claude Code settings give it; a pick is passed to the app's Claude Code sessions as `language` in `--settings`, so it also sets the language Claude Code replies in there.

`/voice settings` in a session opens Settings › Providers at that session's provider, on its voice row. No method here carries the mode, and nothing is written into any provider's own configuration. From another device the device in hand is the microphone: dictation's frames reach the machine over the encrypted relay, and a call's offer and answer pass through the machine. The speech socket and `thread/realtime/appendSpeech` are the daemon's own, and no client calls them.

There is one recording and one call at a time on this computer, so the verbs on the one in progress name no session; the frames they stream still carry it.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `voice.state.update` | `mutation` | `VoiceState` | `VoiceState` |
| `voice.state.subscribe` | `subscription` | `EmptyPayload` | `VoiceState` (stream) |
| `voice.dictation.start` | `mutation` | `VoiceDictationStartRequest` | `EmptyPayload` |
| `voice.dictation.write` | `mutation` | `VoiceDictationWriteRequest` | `EmptyPayload` |
| `voice.dictation.stop` | `mutation` | `VoiceDictationStopRequest` | `EmptyPayload` |
| `voice.dictation.subscribe` | `subscription` | `EmptyPayload` | `VoiceDictationFrame` (stream) |
| `voice.call.start` | `mutation` | `VoiceCallStartRequest` | `VoiceCallStartResponse` |
| `voice.call.stop` | `mutation` | `EmptyPayload` | `EmptyPayload` |
| `voice.call.subscribe` | `subscription` | `EmptyPayload` | `VoiceCallFrame` (stream) |
| `voice.list` | `query` | `EmptyPayload` | `VoiceListResponse` |

Voice on an account whose sign-in kind its provider gives no voice (on Claude Code, an API-key or cloud-provider account) is refused with `voice.accountNotEntitled` (403), `data.fields` `{reason: signInKindNotEntitled, provider}`, `provider` the session's, and the strip draws one sentence, the same on every provider: `Voice isn't available on <account>.` A provider or installed build without voice refuses `voice.dictation.start` and `voice.call.start` with `provider.capability.unsupported`. `voice.call.start` refuses with `voice.call.startFailed` (503) when the provider's realtime service or the network failed before its answer arrived, with `provider.account.notAuthenticated` when the provider refused the account's sign-in, with `provider.account.allowanceExhausted` (429) when the account's allowance is spent, and with `provider.timeout` when no answer came in time.

```ts
// Which session voice is on in, or null when it is off: the request of `voice.state.update`, its
// result, and each delivery of `voice.state.subscribe`, the first of which is the current state.
// Moving it ends the other session's call, and `Voice ended` lands there.
interface VoiceState {
  sessionId: SessionId | null;
}

// Dictation, on a Claude Code session. The request carries no mode: hold or tap is the window's,
// read from the machine's settings file, and the socket runs the same in both.
interface VoiceDictationStartRequest {
  sessionId: SessionId;
}
// One frame of the recording's audio: 16 kHz 16-bit mono PCM, at most 100 ms (3,200 bytes) and whole
// 16-bit samples, sent as a `Bytes<2, 3200>` attachment beside the JSON. 600 frames a minute, about
// 32 KB a second. `sequenceNumber` counts the recording's frames from 0. The recording is bound to its
// session, not to the connection that started it, so after a reconnect the window's writes continue the
// same recording, and a frame whose number the service already holds is dropped.
interface VoiceDictationWriteRequest {
  sequenceNumber: number;
  audio: Uint8Array;
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
  | { reason: "noSound" }
  // `No speech heard.`: the recording closed having heard sound but no words.
  | { reason: "noSpeech" }
  // `Dictation couldn't be sent.` with `Try again`: the connection failed after the one retry, or
  // the service refused with a 4xx other than 401 or 403.
  | { reason: "notSent" }
  // `Dictation couldn't sign in to <account>.` with `Sign in again`: the service refused the
  // account's sign-in (401 or 403).
  | { reason: "signInRefused" }
  // The speech service's own error, in its own words.
  | { reason: "serviceError"; message: string };

// A Codex call, started at the first hold or tap of Space once voice is on there. The daemon passes
// the offer in `thread/realtime/start` with the voice picked in the machine's settings file, where
// one is picked, and the session's earlier spoken exchange, and returns Codex's answer.
interface VoiceCallStartRequest {
  sessionId: SessionId;
  offerSdp: string; // non-empty
}
interface VoiceCallStartResponse {
  answerSdp: string; // non-empty
}
// `voice.call.stop` takes `EmptyPayload`, sent once the window has closed the call: when voice
// is turned off or moves to another session.
// One push of the call stream: the call started; the words the call hears from the person as they
// arrive, then settled; the voice's reply, settled; the call ended, with its cause.
type VoiceCallFrame =
  | { kind: "started"; sessionId: SessionId }
  | { kind: "userTranscriptDelta"; sessionId: SessionId; delta: string }
  | { kind: "userTranscriptDone"; sessionId: SessionId; text: string }
  | { kind: "agentTranscriptDone"; sessionId: SessionId; text: string }
  | ({ kind: "ended"; sessionId: SessionId } & VoiceCallEndCause);
// Why a call ended: the daemon stopped it, Codex closed it with its own reason or none, or Codex
// reported an error in its own words.
type VoiceCallEndCause =
  | { cause: "stopped" }
  | { cause: "closed"; reason: string | null }
  | { cause: "error"; message: string }; // non-empty

// The voices Codex offers a call (its own `v1` list) and the one it uses until the person picks
// another, for the `Voice` row of Settings › Providers › Codex. The pick is written to the
// machine's settings file, never into Codex's configuration.
interface VoiceListResponse {
  voices: string[]; // each non-empty
  defaultVoice: string; // non-empty
}
```
