//! The stand-ins the method inputs are built from: an in-memory keychain, a status read that
//! accepts every token, a usage record no test reads, no live session and a sign-in that never
//! ends.

use std::collections::BTreeMap;
use std::error::Error;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt as _;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use secrecy::{ExposeSecret as _, SecretString};
use sidekicks_contracts::keychain::KeychainRefusalCause;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::account::sign_in::{
    PROVIDER_SIGN_IN_CODE_MAX_LEN, ProviderSignInArm, ProviderSignInCancelStatus,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::web_address::HttpsAddress;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::account::credential_home::CredentialHome;
use sidekicks_provider::account::observer::AccountLiveTurns;
use sidekicks_provider::driver::ProviderAccountFolders;
use sidekicks_provider::driver::contract::account::{
    ProviderSignInHandle, ProviderSignInInput, ProviderSignInLegs, ProviderSignInObservation,
    ProviderTokenStatusLegs,
};
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::port::usage_sink::{
    MeteredUsage, PricedRequest, ProviderQuotaWindow, RecordedUsage, UsageSink,
};
use sidekicks_provider::usage_delta_accountant::UsageAxisCounts;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::credential_store::{KeychainRefusal, SecretKeychain};

use crate::orchestration::account_switch::SessionLevelMoves;

// An in-memory keychain service that keeps every value written, until it is told to refuse
// writes.
#[derive(Default)]
pub(super) struct HeldTokens(pub(super) Mutex<BTreeMap<String, String>>, AtomicBool);

impl HeldTokens {
    pub(super) fn refuse_writes(&self) {
        self.1.store(true, Ordering::SeqCst);
    }
}

impl SecretKeychain for HeldTokens {
    fn write<'call>(
        &'call self,
        account: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), KeychainRefusal>> {
        if self.1.load(Ordering::SeqCst) {
            let refusal = KeychainRefusal::of_test_keychain(KeychainRefusalCause::Unavailable);
            return async { Err(refusal) }.boxed();
        }
        lock(&self.0).insert(account.to_owned(), value.expose_secret().to_owned());
        async { Ok(()) }.boxed()
    }

    fn read<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<Option<SecretString>, KeychainRefusal>> {
        let held = lock(&self.0).get(account).cloned().map(SecretString::from);
        async move { Ok(held) }.boxed()
    }

    fn remove<'call>(
        &'call self,
        account: &'call str,
    ) -> BoxFuture<'call, Result<bool, KeychainRefusal>> {
        let removed = lock(&self.0).remove(account).is_some();
        async move { Ok(removed) }.boxed()
    }

    fn accounts(&self) -> BoxFuture<'_, Result<Vec<String>, KeychainRefusal>> {
        let accounts = lock(&self.0).keys().cloned().collect();
        async move { Ok(accounts) }.boxed()
    }
}

// A provider's status read that accepts every pasted token as an OAuth token.
pub(super) struct AcceptingStatusRead;

impl ProviderTokenStatusLegs for AcceptingStatusRead {
    fn read_token_status<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>> {
        async { Ok(Some(ProviderAuthMode::OauthToken)) }.boxed()
    }

    fn hand_resupplied_token<'call>(
        &'call self,
        _provider_account_id: &'call ProviderAccountId,
        _folders: &'call ProviderAccountFolders,
        _token: &'call SecretString,
    ) -> BoxFuture<'call, Result<(), DriverError>> {
        async { Ok(()) }.boxed()
    }
}

// A usage record no test reads: no provider here has a limits read or a window turn.
pub(super) struct UnreadUsage;

impl UsageSink for UnreadUsage {
    fn record_metered(
        &self,
        _metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>> {
        async { Err("no turn is metered here".into()) }.boxed()
    }

    fn record_cost(
        &self,
        _request: PricedRequest,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no request is priced here".into()) }.boxed()
    }

    fn record_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no window is read here".into()) }.boxed()
    }

    fn record_whole_quota_windows(
        &self,
        _provider: ProviderId,
        _provider_account_id: ProviderAccountId,
        _windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no window is read here".into()) }.boxed()
    }

    fn read_prior_emitted(
        &self,
        _session_id: SessionId,
        _thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>> {
        async { Err("no thread resumes here".into()) }.boxed()
    }

    fn is_request_recorded(
        &self,
        _provider_account_id: ProviderAccountId,
        _request_key: String,
    ) -> BoxFuture<'_, Result<bool, Box<dyn Error + Send + Sync>>> {
        async { Ok(false) }.boxed()
    }

    fn read_thread_speed_at(
        &self,
        _session_id: SessionId,
        _at: WireInstant,
    ) -> BoxFuture<'_, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }

    fn read_run_at(
        &self,
        _session_id: SessionId,
        _at: WireInstant,
    ) -> BoxFuture<'_, Result<Option<RunId>, Box<dyn Error + Send + Sync>>> {
        async { Ok(None) }.boxed()
    }
}

// No session holds a turn or a running process here.
pub(super) struct NoSessions;

impl AccountLiveTurns for NoSessions {
    fn sessions_with_live_turns(&self, _provider_account_id: &ProviderAccountId) -> Vec<SessionId> {
        Vec::new()
    }
}

impl SessionLevelMoves for NoSessions {
    fn change_level(
        &self,
        _session_id: SessionId,
        _level: PermissionLevel,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no session runs here".into()) }.boxed()
    }
}

// A sign-in whose flow starts and never ends, so its account stays signing in.
pub(super) struct EndlessSignIn;

impl ProviderSignInLegs for EndlessSignIn {
    fn start_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
        _arm: ProviderSignInArm,
    ) -> BoxFuture<'_, Result<ProviderSignInHandle, DriverError>> {
        async {
            Ok(ProviderSignInHandle {
                verification_uri: HttpsAddress::new("https://claude.ai/oauth/authorize")
                    .expect("an https address"),
                user_code: None,
                expires_at: None,
                is_browser_opened_by_provider: false,
                code_prompts: futures::stream::pending().boxed(),
                input: Box::new(EndlessSignIn),
                completion: futures::future::pending().boxed(),
            })
        }
        .boxed()
    }

    fn observe_sign_in(
        &self,
        _provider_account_id: ProviderAccountId,
        _home: CredentialHome,
    ) -> BoxFuture<'_, Result<ProviderSignInObservation, DriverError>> {
        unreachable!("the flow never ends")
    }
}

impl ProviderSignInInput for EndlessSignIn {
    fn write_code(
        &self,
        _code: FreeFormText<PROVIDER_SIGN_IN_CODE_MAX_LEN>,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        unreachable!("no code is pasted")
    }

    fn cancel(&self) -> BoxFuture<'_, Result<ProviderSignInCancelStatus, DriverError>> {
        unreachable!("no sign-in is canceled")
    }
}
