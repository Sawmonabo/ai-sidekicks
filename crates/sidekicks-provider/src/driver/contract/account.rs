//! The account legs every provider driver carries out for the account plane: each of a provider's
//! own acts on one account's home, named for the act, so the plane reads one object per provider
//! and never branches on which provider it is.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use secrecy::SecretString;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{
    PROVIDER_ACCOUNT_EMAIL_MAX_LEN, PROVIDER_ACCOUNT_ORG_ID_MAX_LEN,
    PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN, PROVIDER_ACCOUNT_PLAN_MAX_LEN, ProviderAccountId,
    ProviderAuthMode,
};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, PROVIDER_SIGN_IN_USER_CODE_MAX_LEN,
    PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::account::credential_home::CredentialHome;
use crate::account::registry::HealthObservation;
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::error::DriverError;
use crate::port::usage_sink::ProviderQuotaWindow;

/// A provider's own acts on one account's home, each run in the home the caller names and no
/// other.
pub trait ProviderAccountLegs: Send + Sync {
    /// Signs `provider_account_id`'s account out through the provider's own sign-out, run in
    /// `folders` and no other home; the folders stay, and emptying them is the caller's. Has no
    /// bound of its own, the caller bounds it. Fails with the driver's error when the sign-out
    /// could not run or the provider refused it.
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// These legs as the provider's limits read, which the background observer runs; `None` for a
    /// provider with no limits read, whose accounts are then never observed.
    fn observe_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderObserveLegs>>;

    /// These legs as the provider's memory import, which `provider.account.memory.import` runs;
    /// `None` for a provider that keeps no memory of the person's own.
    fn memory_import_legs(self: Arc<Self>) -> Option<Arc<dyn ProviderMemoryImportLegs>>;
}

/// A provider's own interactive sign-in, run in one account's home: the flow's start, and the
/// status read that names who signed in once the flow has ended.
pub trait ProviderSignInLegs: Send + Sync {
    /// Starts the provider's own sign-in for `provider_account_id` in `home` and no other, on the
    /// arm `origin` calls for, and answers once the flow has shown what the person needs. Fails
    /// with a `provider.account.signInUnsupported` refusal, nothing started, where the arm emits
    /// neither an address nor a code, and with the driver's error where the flow could not start.
    fn start_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
        origin: SignInOrigin,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>>;

    /// Reads the provider's own status in `home` after a sign-in there ended: the account's
    /// health and whether the provider named the account. Opens no credential file. Fails with
    /// the driver's error where the status could not be read.
    fn observe_sign_in(
        &self,
        provider_account_id: ProviderAccountId,
        home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>>;
}

/// Where a sign-in was started: a browser on another device cannot reach a provider's callback on
/// this machine, so a sign-in started there takes the arm that needs none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInOrigin {
    /// This machine's own client.
    ThisMachine,
    /// A linked device.
    AnotherDevice,
}

/// A started sign-in as the provider's flow reported it, parsed into typed fields and never a line
/// of its stream: the address and code the person needs, the attempt's bound, each moment the
/// flow waits for the code its sign-in page shows, the flow's input and its end.
pub struct ProviderSignInHandle {
    /// Where the person finishes the flow, checked against the provider's own address.
    pub verification_uri: HttpsAddress<PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN>,
    /// The device code the person types at the address, on a device-code flow.
    pub user_code: Option<FreeFormText<PROVIDER_SIGN_IN_USER_CODE_MAX_LEN>>,
    /// Where the provider bounds the attempt, in the future and within its ceiling, else `None`.
    pub expires_at: Option<WireInstant>,
    /// One item each time the flow waits for a pasted code, read from its prompt and carrying
    /// none of the prompt's text; empty on a flow that never asks.
    pub code_prompts: BoxStream<'static, ()>,
    /// The flow's input and its cancel.
    pub input: Box<dyn ProviderSignInInput>,
    /// The flow's end, from the provider's own completion signal; it always resolves, as
    /// [`ProviderSignInEnd::Canceled`] after a cancel.
    pub completion: BoxFuture<'static, ProviderSignInEnd>,
}

/// The input of one running sign-in flow: the sink for the code its sign-in page shows, and its
/// cancel.
pub trait ProviderSignInInput: Send + Sync {
    /// Writes `code` to this flow's own input and nowhere else; the code is never logged. Fails
    /// with the driver's error where the flow no longer takes input.
    fn write_code(
        &self,
        code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> BoxFuture<'_, Result<(), DriverError>>;

    /// Ends this flow through the provider's own cancel, freeing its sign-in slot; the flow's
    /// completion then answers canceled. Fails with the driver's error where the cancel could not
    /// be sent.
    fn cancel(&self) -> BoxFuture<'_, Result<(), DriverError>>;
}

/// How the provider's own sign-in flow ended, before any observation of the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderSignInEnd {
    /// The provider reported its flow finished.
    Finished,
    /// The flow failed or its process ended without finishing.
    Failed,
    /// The attempt outlived its bound.
    Expired,
    /// The flow was canceled.
    Canceled,
}

/// The status read after a sign-in ended: the account's health as observed, and whether the
/// provider named the account that signed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSignInObservation {
    /// The account's health.
    pub health: HealthObservation,
    /// Whether the provider reported who signed in.
    pub is_account_named: bool,
}

/// A provider's status read of a pasted token or API key: the registration-time invocation that
/// observes whether the provider accepts it, run once per registration and once per re-supply.
pub trait ProviderTokenStatusLegs: Send + Sync {
    /// The signed-in mode the provider's own status read reports for `token` on
    /// `provider_account_id`'s account, run in `folders` with the token handed to that one child on
    /// the provider's documented channel; `None` when it reports no signed-in mode. Has no bound of
    /// its own, the caller bounds it. Fails with the driver's error when the read could not run.
    fn read_token_status<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>>;
}

/// What one limits read of an account's home answered, as the account plane stores it: each arm
/// names what the provider said, never which provider said it.
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderObservation {
    /// The provider answered with the account's limits.
    Figures(ProviderAccountFigures),
    /// The provider refused or throttled the read in its answer, so its last figures stand.
    RefusedInBand,
    /// The provider refused the read in its answer after refusing the account's sign-in on the
    /// way to it, which cannot tell a sign-in revoked early from a throttle.
    SignInRefusedBeforeAnswer,
    /// The provider answered that the account's sign-in is gone.
    SignInGone,
    /// The answer is outside what this read judges for the account, as a pasted token's scope,
    /// which another read takes.
    OutOfScope,
    /// The provider answered with neither the account's limits nor a judgement of its sign-in, as
    /// a read it does not serve where it ran.
    Unanswered,
}

/// What a limits read that answered carried: the account's whole set of quota windows, the
/// identity the provider reported with it, and when the provider last renewed the home's sign-in,
/// each part empty or absent where the provider said nothing of it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderAccountFigures {
    /// Every quota window the read named.
    pub windows: Vec<ProviderQuotaWindow>,
    /// Who the provider says the account is.
    pub identity: ObservedAccountIdentity,
    /// When the provider last renewed the home's sign-in, read from its own durable mark.
    pub refreshed_at: Option<WireInstant>,
}

/// The account's identity as the provider reported it, each member absent where it did not; a
/// person's data, so its debug form names only which members are present.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ObservedAccountIdentity {
    /// The account's email.
    pub email: Option<FreeFormText<PROVIDER_ACCOUNT_EMAIL_MAX_LEN>>,
    /// The plan, in the provider's own word.
    pub plan: Option<FreeFormText<PROVIDER_ACCOUNT_PLAN_MAX_LEN>>,
    /// The organization's id.
    pub org_id: Option<FreeFormText<PROVIDER_ACCOUNT_ORG_ID_MAX_LEN>>,
    /// The organization's name.
    pub org_name: Option<FreeFormText<PROVIDER_ACCOUNT_ORG_NAME_MAX_LEN>>,
}

impl std::fmt::Debug for ObservedAccountIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ObservedAccountIdentity")
            .field("has_email", &self.email.is_some())
            .field("has_plan", &self.plan.is_some())
            .field("has_org_id", &self.org_id.is_some())
            .field("has_org_name", &self.org_name.is_some())
            .finish()
    }
}

/// A provider's limits read of one account's home, the background observer's one read, run in the
/// home the caller names and no other.
pub trait ProviderObserveLegs: Send + Sync {
    /// Reads `provider_account_id`'s limits in `folders` and no other home, spending no model
    /// turn. Has no bound of its own, the caller bounds it. Fails with the driver's error when the
    /// read could not start or no answer came.
    fn observe(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<ProviderObservation, DriverError>>;

    /// Whether this provider's reads run one at a time across all its accounts, each starting a
    /// process of its own.
    fn reads_one_at_a_time(&self) -> bool;

    /// Whether a turn's end on an account is followed by a read of it, since the provider's turns
    /// bring no full reading of their own.
    fn reads_at_turn_end(&self) -> bool;
}

/// One of the person's own provider memory stores, a folder their own home holds, and the folders
/// the memory import copies it into, each absolute.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryImportStore {
    /// The folder of the person's own memory, only ever read; it may not stand.
    pub source: PathBuf,
    /// Where it is copied, never over a file already there.
    pub destinations: Vec<PathBuf>,
}

/// Where a provider keeps the person's own memory and where the memory import copies it for one
/// account, so the import itself never names a provider.
pub trait ProviderMemoryImportLegs: Send + Sync {
    /// The person's own memory stores, each with the folders it is copied into for the account
    /// whose home is `home`; a store whose folder does not stand holds no memory to copy. Lists
    /// folders of the person's own home and writes nothing, so it blocks and runs off the
    /// runtime's threads. Fails with the system's error when a folder of the person's own home
    /// cannot be listed.
    fn memory_import_stores(&self, home: &CredentialHome) -> io::Result<Vec<MemoryImportStore>>;
}

/// What one smallest turn in an account's home spent, as the provider reported it: the model and
/// the turn's own token counts, each absent where the provider reported none, never zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowTurnSpend {
    /// The model the turn ran on, as the provider names it.
    pub model_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    /// The input tokens, with the cache's read and written tokens taken out.
    pub input_tokens: Option<SafeInt<0>>,
    /// The output tokens.
    pub output_tokens: Option<SafeInt<0>>,
    /// The input tokens read from the provider's cache.
    pub cache_read_tokens: Option<SafeInt<0>>,
    /// The input tokens written to the provider's cache.
    pub cache_write_tokens: Option<SafeInt<0>>,
    /// The reasoning tokens.
    pub reasoning_tokens: Option<SafeInt<0>>,
}

/// What a window-start turn answered: the turn ran and spent, or the provider refused it before
/// any spend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowTurnAnswer {
    /// The turn ran, and this is what it spent.
    Spent(WindowTurnSpend),
    /// The provider refused the turn, which spent nothing.
    Refused,
}

/// What a pasted token's limits read by a turn answered: the reading its turn carried, as the
/// account plane stores it, and what the turn spent, `None` where it ran no turn.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimitsReading {
    /// What the turn's answer said of the account's limits and sign-in.
    pub observation: ProviderObservation,
    /// What the turn spent.
    pub spend: Option<WindowTurnSpend>,
}

/// A provider's smallest turns in an account's home, each in a throwaway process holding no
/// session: the one that starts the account's closed usage windows, and the one that reads a
/// pasted token's limits, which the token's own scope cannot read.
pub trait ProviderWindowTurnLegs: Send + Sync {
    /// Sends one short message to the provider's smallest model on `provider_account_id`'s
    /// account, run in `folders` and no other home, and answers what the turn spent or the
    /// provider's refusal. Has no bound of its own, the caller bounds it. Fails with the driver's
    /// error when the turn could not start or no answer came.
    fn start_window(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<WindowTurnAnswer, DriverError>>;

    /// Reads the limits of `provider_account_id`'s pasted `token` by one such turn, run in
    /// `folders` with the token handed to that one child on the provider's documented channel.
    /// Has no bound of its own, the caller bounds it. Fails with the driver's error when the turn
    /// could not start or no answer came.
    fn read_token_limits<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<TokenLimitsReading, DriverError>>;
}

/// One running session a switch moves: the session, and the binding its lead runs on, which moves
/// with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionToMove {
    /// The session.
    pub session_id: SessionId,
    /// The binding its lead runs on.
    pub binding_id: RuntimeBindingId,
}

/// How a moved session's first request on the account it moved to went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FirstRequestAfterMove {
    /// The provider answered it on the new account.
    Ran,
    /// The provider refused it for the new account's login, so the session was handed its
    /// previous account back, bindings included.
    HandedBack,
    /// No request was seen: the session ran no process, or its process ended first.
    Unobserved,
}

/// One session's move onto another account, settled once the move landed.
pub struct SessionAccountMove {
    /// The session.
    pub session_id: SessionId,
    /// Settles once the session's first request after the move is answered, refused for its
    /// login or no longer to come; fails with the driver's error where a hand-back could not be
    /// made, the session then left on the account it moved to.
    pub first_request: BoxFuture<'static, Result<FirstRequestAfterMove, DriverError>>,
}

/// A provider's move of its running sessions from one account to another, each in place where
/// the provider can and else between turns, its bindings moving with it.
pub trait ProviderSwitchLegs: Send + Sync {
    /// Moves each of `sessions` from account `from` onto `to`, answering once every move landed:
    /// at the provider's acknowledgment, at a restart between turns, or at once for a session
    /// running no process. A session's move fails with the driver's error, leaving it on `from`,
    /// where the provider refused it or the session could not be moved; the other moves go on.
    fn move_sessions(
        &self,
        from: ProviderAccountId,
        to: ProviderAccountId,
        sessions: Vec<SessionToMove>,
    ) -> BoxFuture<'_, Vec<Result<SessionAccountMove, (SessionId, DriverError)>>>;
}
