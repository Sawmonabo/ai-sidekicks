//! Voice, as a window drives it through the daemon: which session voice is on in, and its two
//! kinds, dictation into the composer and a spoken call with the provider, of which each provider's
//! section declares the ones it offers. Voice is on in one session at a time on this computer,
//! held by the daemon and off after it restarts, and there is one recording and one call at a
//! time, so the methods on the one in progress name no session. Dictation audio is 16 kHz 16-bit
//! mono PCM in 100 ms frames; the window is a call's WebRTC peer and hands its offer here. No
//! provider credential crosses these methods in either direction.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::id::ProviderId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::attachment::Bytes;
use crate::wire::list::closed_list_key;
use crate::wire::text::NonEmptyText;
use crate::wire::{NullableSchema, literal, nullable};

ts_constants! {
    /// The bytes in one 100 ms frame of 16 kHz 16-bit mono audio.
    pub const VOICE_DICTATION_FRAME_MAX_BYTES: usize = 16_000 * 2 / 10;
    /// Every reason an account is not entitled to voice, for the composer strip's refusal line.
    VOICE_ACCOUNT_NOT_ENTITLED_REASONS = VoiceAccountNotEntitledReason::VARIANTS;
    /// Every reason a recording can end without its words, for the composer strip's refusal line.
    VOICE_DICTATION_FAILURE_REASONS = VoiceDictationFailureReason::VARIANTS;
}

literal! {
    /// Where a message in the transcript came from when no one typed it: a voice call, heard or
    /// spoken. A typed message carries no origin.
    pub enum MessageOrigin = "voice";
}

/// A kind of voice a provider offers, which its section declares: the composer starts the
/// matching method, `voice.dictation.start` or `voice.call.start`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum VoiceKind {
    /// Dictation into the composer.
    Dictation,
    /// A spoken call with the provider.
    Call,
}

closed_list_key!(VoiceKind);

/// Why `voice.accountNotEntitled` refused: the account is signed in, but its provider gives its
/// sign-in kind no voice.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum VoiceAccountNotEntitledReason {
    /// The account's sign-in kind has no voice on its provider.
    SignInKindNotEntitled,
}

/// The `voice.accountNotEntitled` refusal's details: why, and the session's provider; the screen
/// draws one sentence naming the account, the same on every provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceAccountNotEntitledDetails {
    /// Why.
    pub reason: VoiceAccountNotEntitledReason,
    /// The session's provider.
    pub provider: ProviderId,
}

/// The session voice is on in, or `null` when it is off: the request and result of
/// `voice.state.update`, and each delivery of `voice.state.subscribe`, the first of which is the
/// current state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceState {
    /// The session, or `null`.
    #[serde(deserialize_with = "nullable")]
    #[schemars(with = "NullableSchema<SessionId>")]
    pub session_id: Option<SessionId>,
}

/// `voice.dictation.start`: starts a recording in a session whose voice is dictation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceDictationStartRequest {
    /// The session.
    pub session_id: SessionId,
}

/// `voice.dictation.write`: one frame of the recording's audio, 16 kHz 16-bit mono PCM, at most
/// 100 ms of it, in whole samples.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceDictationWriteRequest {
    /// The frame; an odd length would end mid-sample.
    #[garde(custom(|audio: &Bytes<1, VOICE_DICTATION_FRAME_MAX_BYTES>, (): &()| {
        if audio.as_bytes().len().is_multiple_of(2) {
            Ok(())
        } else {
            Err(garde::Error::new("audio must hold whole 16-bit samples"))
        }
    }))]
    #[schemars(extend("evenBytes" = true))]
    pub audio: Bytes<1, VOICE_DICTATION_FRAME_MAX_BYTES>,
}

/// `voice.dictation.stop`: stops the recording; `cancel` drops it, and its words with it.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceDictationStopRequest {
    /// Whether to drop the recording.
    pub cancel: bool,
}

/// Why a recording ended without its words: only silent samples reached the microphone; sound but
/// no words; the connection failed after its one retry or was refused; the speech service refused
/// the account's sign-in.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum VoiceDictationFailureReason {
    /// Only silent samples reached the microphone.
    NoSound,
    /// Sound, but no words.
    NoSpeech,
    /// The connection failed after its one retry, or was refused.
    NotSent,
    /// The speech service refused the account's sign-in.
    SignInRefused,
}

literal! {
    /// The reason of a speech service's own error.
    pub enum VoiceServiceErrorReason = "serviceError";
}

/// A recording's failure with a known reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct VoiceDictationKnownFailure {
    /// Why.
    pub reason: VoiceDictationFailureReason,
}

/// The speech service's own error, in its own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct VoiceDictationServiceError {
    /// Always `serviceError`.
    pub reason: VoiceServiceErrorReason,
    /// The service's words.
    pub message: NonEmptyText,
}

/// A recording's failure, or the speech service's own error in its own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum VoiceDictationFailure {
    /// A known reason.
    Known(VoiceDictationKnownFailure),
    /// The service's own error.
    ServiceError(VoiceDictationServiceError),
}

/// One push of a `voice.dictation.subscribe` stream: `words` carries the settled words and the
/// words still in progress, which the draft shows in that order with a space between; `ended`
/// closes the recording, with its failure or `null`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum VoiceDictationFrame {
    /// The words so far.
    Words {
        /// The session.
        session_id: SessionId,
        /// The settled words.
        committed: String,
        /// The words still in progress.
        in_progress: String,
    },
    /// The recording ended.
    Ended {
        /// The session.
        session_id: SessionId,
        /// Its failure, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<VoiceDictationFailure>")]
        failure: Option<VoiceDictationFailure>,
    },
}

/// `voice.call.start`: starts a call in a session whose voice is a spoken call, with the window's
/// WebRTC offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceCallStartRequest {
    /// The session.
    pub session_id: SessionId,
    /// The window's offer.
    pub offer_sdp: NonEmptyText,
}

/// The provider's WebRTC answer to the window's offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceCallStartResponse {
    /// The answer.
    pub answer_sdp: NonEmptyText,
}

literal! {
    /// A call frame saying the call started.
    pub enum VoiceCallStartedKind = "started";
    /// A call frame carrying the words the call hears as they arrive.
    pub enum VoiceCallUserTranscriptDeltaKind = "userTranscriptDelta";
    /// A call frame carrying the words the call heard, settled.
    pub enum VoiceCallUserTranscriptDoneKind = "userTranscriptDone";
    /// A call frame carrying the voice's reply, settled.
    pub enum VoiceCallAssistantTranscriptDoneKind = "assistantTranscriptDone";
    /// A call frame saying the call ended.
    pub enum VoiceCallEndedKind = "ended";
    /// The daemon stopped the call.
    pub enum VoiceCallStoppedCause = "stopped";
    /// The provider closed the call.
    pub enum VoiceCallClosedCause = "closed";
    /// The provider reported an error.
    pub enum VoiceCallErrorCause = "error";
}

/// Declares one arm of a call frame with the members every arm repeats.
macro_rules! call_frame {
    ($(
        $(#[doc = $doc:literal])+
        $name:ident($kind:ty) { $($extra:tt)* }
    )+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The frame's kind.
            pub kind: $kind,
            /// The session.
            pub session_id: SessionId,
            $($extra)*
        }
    )+};
}

call_frame! {
    /// The call started.
    VoiceCallStartedFrame(VoiceCallStartedKind) {}
    /// Words the call hears from the person, as they arrive.
    VoiceCallUserTranscriptDeltaFrame(VoiceCallUserTranscriptDeltaKind) {
        /// The new words.
        pub delta: String,
    }
    /// The words the call heard from the person, settled.
    VoiceCallUserTranscriptDoneFrame(VoiceCallUserTranscriptDoneKind) {
        /// The words.
        pub text: String,
    }
    /// The voice's reply, settled.
    VoiceCallAssistantTranscriptDoneFrame(VoiceCallAssistantTranscriptDoneKind) {
        /// The words.
        pub text: String,
    }
    /// The daemon stopped the call.
    VoiceCallStoppedFrame(VoiceCallEndedKind) {
        /// Always `stopped`.
        pub cause: VoiceCallStoppedCause,
    }
    /// The provider closed the call, with its own reason or none.
    VoiceCallClosedFrame(VoiceCallEndedKind) {
        /// Always `closed`.
        pub cause: VoiceCallClosedCause,
        /// The provider's reason, or `null`.
        #[serde(deserialize_with = "nullable")]
        #[schemars(with = "NullableSchema<String>")]
        pub reason: Option<String>,
    }
    /// The provider reported an error, in its own words.
    VoiceCallErrorFrame(VoiceCallEndedKind) {
        /// Always `error`.
        pub cause: VoiceCallErrorCause,
        /// The provider's words.
        pub message: NonEmptyText,
    }
}

/// One push of a `voice.call.subscribe` stream: the call started; the words the call hears from the
/// person as they arrive, then settled; the voice's reply, settled; the call ended, with its cause.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum VoiceCallFrame {
    /// The call started.
    Started(VoiceCallStartedFrame),
    /// Words heard, as they arrive.
    UserTranscriptDelta(VoiceCallUserTranscriptDeltaFrame),
    /// Words heard, settled.
    UserTranscriptDone(VoiceCallUserTranscriptDoneFrame),
    /// The reply, settled.
    AssistantTranscriptDone(VoiceCallAssistantTranscriptDoneFrame),
    /// The daemon stopped the call.
    Stopped(VoiceCallStoppedFrame),
    /// The provider closed the call.
    Closed(VoiceCallClosedFrame),
    /// The provider reported an error.
    Error(VoiceCallErrorFrame),
}

/// The voices the provider offers a call, and the one it uses until the person picks another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct VoiceListResponse {
    /// The voices.
    pub voices: Vec<NonEmptyText>,
    /// The voice used until the person picks another.
    pub default_voice: NonEmptyText,
}

methods! {
    /// The `voice.*` methods.
    pub const VOICE_METHOD_DESCRIPTORS = [
        /// Turns voice on in a session, or off.
        VoiceStateUpdate = mutation "voice.state.update" {
            mutating: true,
            params: VoiceState,
            result: VoiceState,
            refusals: [SessionNotFound],
        },
        /// Follows which session voice is on in.
        VoiceStateSubscribe = subscription "voice.state.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: VoiceState,
            refusals: [],
        },
        /// Starts a recording.
        VoiceDictationStart = mutation "voice.dictation.start" {
            mutating: true,
            params: VoiceDictationStartRequest,
            result: EmptyPayload,
            refusals: [SessionNotFound, VoiceAccountNotEntitled, ProviderCapabilityUnsupported],
        },
        /// Sends one frame of the recording.
        VoiceDictationWrite = mutation "voice.dictation.write" {
            mutating: true,
            params: VoiceDictationWriteRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Stops the recording.
        VoiceDictationStop = mutation "voice.dictation.stop" {
            mutating: true,
            params: VoiceDictationStopRequest,
            result: EmptyPayload,
            refusals: [],
        },
        /// Follows the recording's words.
        VoiceDictationSubscribe = subscription "voice.dictation.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: VoiceDictationFrame,
            refusals: [],
        },
        /// Starts a spoken call.
        VoiceCallStart = mutation "voice.call.start" {
            mutating: true,
            params: VoiceCallStartRequest,
            result: VoiceCallStartResponse,
            refusals: [
                SessionNotFound,
                VoiceAccountNotEntitled,
                ProviderCapabilityUnsupported,
                VoiceCallStartFailed,
                ProviderAccountNotAuthenticated,
                ProviderAccountAllowanceExhausted,
                ProviderTimeout,
            ],
        },
        /// Stops the call.
        VoiceCallStop = mutation "voice.call.stop" {
            mutating: true,
            params: EmptyPayload,
            result: EmptyPayload,
            refusals: [],
        },
        /// Follows the call.
        VoiceCallSubscribe = subscription "voice.call.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: VoiceCallFrame,
            refusals: [],
        },
        /// The voices the provider offers a call.
        VoiceList = query "voice.list" {
            mutating: false,
            params: EmptyPayload,
            result: VoiceListResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of voice.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "voice",
    doc: "Voice, as a window drives it through the daemon: which session voice is on in, and its \
          two mechanisms, dictation into the composer and a spoken call with the provider.",
    definitions: &[
        Definition::read::<MessageOrigin>().checked(),
        Definition::read::<VoiceKind>(),
        Definition::read::<VoiceAccountNotEntitledReason>(),
        Definition::read::<VoiceAccountNotEntitledDetails>().checked(),
        Definition::read::<VoiceState>().checked(),
        Definition::read::<VoiceDictationStartRequest>(),
        Definition::read::<VoiceDictationWriteRequest>().checked(),
        Definition::read::<VoiceDictationStopRequest>(),
        Definition::read::<VoiceDictationFailureReason>(),
        Definition::read::<VoiceDictationFailure>(),
        Definition::read::<VoiceDictationFrame>().checked(),
        Definition::read::<VoiceCallStartRequest>(),
        Definition::read::<VoiceCallStartResponse>(),
        Definition::read::<VoiceCallFrame>().checked(),
        Definition::read::<VoiceListResponse>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&VOICE_METHOD_DESCRIPTORS],
};
