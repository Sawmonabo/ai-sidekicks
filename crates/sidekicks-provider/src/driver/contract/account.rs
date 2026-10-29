//! The account legs every provider driver carries out for the account plane: each of a provider's
//! own acts on one account's home, named for the act, so the plane reads one object per provider
//! and never branches on which provider it is.

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use secrecy::SecretString;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, PROVIDER_SIGN_IN_USER_CODE_MAX_LEN,
    PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN,
};
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::account::credential_home::CredentialHome;
use crate::account::registry::HealthObservation;
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::error::DriverError;

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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderObservation {
    /// The provider answered with the account's limits.
    Figures,
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
#[derive(Clone, Debug, PartialEq, Eq)]
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
