//! The account legs every provider driver carries out for the account plane: each of a provider's
//! own acts on one account's home, named for the act, so the plane reads one object per provider
//! and never branches on which provider it is.

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, PROVIDER_SIGN_IN_USER_CODE_MAX_LEN,
    PROVIDER_SIGN_IN_VERIFICATION_URI_MAX_LEN,
};
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
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
