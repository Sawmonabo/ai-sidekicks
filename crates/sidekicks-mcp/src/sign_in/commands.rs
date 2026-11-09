//! The receipted sign-in and sign-out commands: a press is answered once per key, its target read
//! from the binding and acted on inside the receipt. A sign-in's page address is served and never
//! saved, so a retry under the key answers the acknowledgment alone and starts nothing; a
//! sign-out answers `{}`, and a retry under the key replays it. A press keeps the address its
//! target read as for the binding, and once answered settles the owed sign-outs.

use std::sync::Arc;

use sidekicks_contracts::mcp::server::requests::{
    McpServerSignInRequest, McpServerSignInResponse, McpServerSignOutRequest,
};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::registry::HandlerError;

use crate::errors::{McpRefusal, SignInUnsupportedReason};
use crate::mutation::service::command::{McpCommand, McpCommandAnswer};
use crate::mutation::service::{McpMutationService, response_of, response_value};
use crate::sign_in::server::SignInTargetReads;
use crate::sign_in::service::{SignInService, SignInTarget, addressed_server};
use crate::sign_in::sign_out::owed::OwedSignOuts;

/// The receipted sign-in and sign-out commands the daemon's handlers forward to.
pub struct McpSignInCommands {
    mutations: Arc<McpMutationService>,
    sign_ins: Arc<SignInService>,
    targets: SignInTargetReads,
    owed: Arc<OwedSignOuts>,
}

impl McpSignInCommands {
    /// The commands over the receipts of `mutations`, the launches of `sign_ins`, the target
    /// reads `targets` and the owed sign-outs `owed`, which each press keeps its address in and
    /// settles once answered.
    pub fn new(
        mutations: Arc<McpMutationService>,
        sign_ins: Arc<SignInService>,
        targets: SignInTargetReads,
        owed: Arc<OwedSignOuts>,
    ) -> Self {
        Self {
            mutations,
            sign_ins,
            targets,
            owed,
        }
    }

    /// Starts a sign-in to `request`'s binding once per key, answering the sign-in page's address,
    /// and a retry under the key with the acknowledgment alone. Refuses as the receipt, the target
    /// read and the launch refuse.
    pub async fn sign_in(
        &self,
        request: McpServerSignInRequest,
    ) -> Result<McpServerSignInResponse, HandlerError> {
        let binding = request.binding();
        let answer = self
            .mutations
            .run_command(
                McpCommand::SignIn,
                request.idempotency_key(),
                &request,
                &binding,
                || async {
                    let read = self.targets.read(&binding).await?;
                    self.note_declared(&read.target).await;
                    let authorization_url = self
                        .sign_ins
                        .launch(&read.target, &read.scopes, &read.provider_accounts)
                        .await?;
                    Ok(McpCommandAnswer {
                        served: response_value(&McpServerSignInResponse {
                            authorization_url: Some(authorization_url),
                        }),
                        saved: response_value(&McpServerSignInResponse {
                            authorization_url: None,
                        }),
                    })
                },
            )
            .await;
        self.owed.start_settle();
        response_of(answer?).map_err(HandlerError::Refused)
    }

    /// Signs out of the server `request`'s binding reaches once per key, answering `{}`, and a
    /// retry under the key with the same answer: the server its address reads as, or where it no
    /// longer reads, the one it last read as. Refuses as the receipt and the address read refuse,
    /// `mcp.server.signInUnsupported` for a binding no sign-in reaches or whose address never
    /// read, `mcp.bindingStoreUnavailable` when the address key or the binding store cannot be
    /// used, and `mcp.server.signOutFailed` when the keychain keeps the sign-in.
    pub async fn sign_out(
        &self,
        request: McpServerSignOutRequest,
    ) -> Result<EmptyPayload, HandlerError> {
        let binding = request.binding();
        let answer = self
            .mutations
            .run_command(
                McpCommand::SignOut,
                request.idempotency_key(),
                &request,
                &binding,
                || async {
                    let address = self.targets.read_sign_out_address(&binding).await?;
                    let digest = self
                        .owed
                        .sign_out_digest(&binding, address.as_ref())
                        .await
                        .map_err(|error| HandlerError::Refused(McpRefusal::from(error).into()))?
                        .ok_or_else(|| {
                            HandlerError::Refused(
                                McpRefusal::ServerSignInUnsupported {
                                    binding: Box::new(binding.clone()),
                                    reason: SignInUnsupportedReason::AddressUnreadable,
                                }
                                .into(),
                            )
                        })?;
                    self.sign_ins
                        .sign_out(&binding, &digest)
                        .await
                        .map_err(|refusal| HandlerError::Refused(refusal.into()))?;
                    let signed_out = response_value(&EmptyPayload {});
                    Ok(McpCommandAnswer {
                        served: signed_out.clone(),
                        saved: signed_out,
                    })
                },
            )
            .await;
        self.owed.start_settle();
        response_of(answer?).map_err(HandlerError::Refused)
    }

    // Keeps the address `target` reached as its binding's last declared one, so a press after the
    // address changed owes the old one's sign-out; a write that fails is logged and the press goes
    // on, since the next read keeps it.
    async fn note_declared(&self, target: &SignInTarget) {
        let Some(server) = addressed_server(target) else {
            return;
        };
        if let Err(error) = self
            .owed
            .note_declared(&target.binding, &server.address)
            .await
        {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "an MCP binding's last declared address was not kept"
            );
        }
    }
}

/// A command's request, keyed by the press in whichever scope it names its binding.
trait CommandRequest {
    /// The press's key; a retry reuses it.
    fn idempotency_key(&self) -> &ClientUuid;
}

// Reads each request's key from every scope arm its binding may be named in.
macro_rules! command_request {
    ($($request:ident),+) => {$(
        impl CommandRequest for $request {
            fn idempotency_key(&self) -> &ClientUuid {
                match self {
                    $request::User { client_idempotency_key, .. }
                    | $request::Project { client_idempotency_key, .. }
                    | $request::Local { client_idempotency_key, .. }
                    | $request::Plugin { client_idempotency_key, .. }
                    | $request::Connector { client_idempotency_key, .. }
                    | $request::Managed { client_idempotency_key, .. } => client_idempotency_key,
                }
            }
        }
    )+};
}

command_request!(McpServerSignInRequest, McpServerSignOutRequest);

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use axum::http::StatusCode;
    use rstest::rstest;
    use serde::de::DeserializeOwned;
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::keychain::KeychainRefusalCause;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;
    use sidekicks_contracts::mcp::server::requests::{
        McpServerSignInRequest, McpServerSignOutRequest,
    };
    use sidekicks_contracts::method_descriptor::EmptyPayload;
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
    use sidekicks_provider::driver::contract::sign_in::McpServerAddressReading;
    use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
    use sidekicks_provider::driver::mcp_server::read::McpServerSignInSettings;
    use sidekicks_provider::runtime_binding::test_store::test_provider_account_id;
    use sidekicks_std::mutex_lock::lock;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::test_keychain;
    use tempfile::TempDir;

    use super::McpSignInCommands;
    use crate::mutation::receipts::tests::idempotency_key;
    use crate::mutation::service::{McpMutationService, McpMutationSources};
    use crate::sign_in::server::tests::{
        TestSources, answer_address_read, docs_binding, driver_declaring, program_declaration,
        remote_declaration, test_sources,
    };
    use crate::sign_in::service::SignInService;
    use crate::sign_in::sign_out::owed::OwedSignOuts;
    use crate::sign_in::sign_out::revocation::tests::{
        address, presented_authorization, received_revocations, signed_in,
    };
    use crate::sign_in::test_service::{
        FakeAuthorizationServer, FakeServerAnswers, harness_with, serve_authorization_server,
    };

    /// The commands over a test's sources, with the receipt key's keychain and the sources kept
    /// alive beside them.
    struct TestCommands {
        commands: McpSignInCommands,
        _sources: TestSources,
        _receipt_keychain: (TempDir, PlatformCredentialStore),
    }

    /// The commands whose targets are read from `driver` and whose sign-ins run on `sign_ins`.
    async fn commands_over(
        driver: Arc<dyn ProviderDriver>,
        sign_ins: &Arc<SignInService>,
    ) -> TestCommands {
        let sources = test_sources(vec![driver]).await;
        let (data_folder, platform_store, keychain) = test_keychain(KeychainService::McpReceiptKey);
        let mutations = Arc::new(McpMutationService::new(McpMutationSources {
            providers: Arc::clone(&sources.providers),
            inventory: Arc::clone(&sources.inventory),
            keychain,
            writer: Arc::clone(&sources.writer),
            reads: Arc::clone(&sources.reads),
            removal_rows: None,
            board: Arc::clone(&sources.board),
        }));
        let owed = OwedSignOuts::new(
            Arc::clone(sign_ins),
            sources.target_reads(),
            Arc::clone(&sources.reads),
            Arc::clone(&sources.writer),
        );
        TestCommands {
            commands: McpSignInCommands::new(
                mutations,
                Arc::clone(sign_ins),
                sources.target_reads(),
                owed,
            ),
            _sources: sources,
            _receipt_keychain: (data_folder, platform_store),
        }
    }

    /// A driver declaring the docs binding at `server`'s address, which it reads once.
    fn driver_reaching(server: &FakeAuthorizationServer) -> Arc<dyn ProviderDriver> {
        let mut driver = driver_declaring(vec![remote_declaration(&docs_binding(), &server.base)]);
        answer_address_read(
            &mut driver,
            Ok(McpServerAddressReading::Declared(address(server))),
        );
        Arc::new(driver)
    }

    /// A press on `binding` under the test key.
    fn press<Request: DeserializeOwned>(binding: &McpServerBindingRef) -> Request {
        let mut request = serde_json::to_value(binding).expect("a binding writes as JSON");
        request["clientIdempotencyKey"] = json!(idempotency_key().as_str());
        serde_json::from_value(request).expect("a keyed request")
    }

    // Killed by `saved` built from `served` (the retry carries the address), and by a launch
    // outside `run_command` (a second launch reads the address again, which the driver answers
    // once, and adds requests to the fake server).
    #[tokio::test]
    async fn a_sign_in_is_launched_once_per_key() {
        let server = serve_authorization_server(FakeServerAnswers::default()).await;
        let driver = driver_reaching(&server);
        let harness = harness_with(vec![Arc::clone(&driver)]).await;
        let test = commands_over(driver, &harness.service).await;
        let request: McpServerSignInRequest = press(&docs_binding());

        let first = test
            .commands
            .sign_in(request.clone())
            .await
            .expect("the first press is served");
        let requests_after_first = server.requests.load(Ordering::SeqCst);
        let retry = test
            .commands
            .sign_in(request)
            .await
            .expect("the retry is answered");

        assert!(first.authorization_url.is_some());
        assert_eq!(retry.authorization_url, None);
        assert_eq!(server.requests.load(Ordering::SeqCst), requests_after_first);
    }

    // Killed by a sign-out outside `run_command`: the retry reads the address again, which the
    // driver answers once.
    #[tokio::test]
    async fn a_sign_out_runs_once_per_key() {
        let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
        let test = commands_over(driver_reaching(&server), &harness.service).await;
        let request: McpServerSignOutRequest = press(&docs_binding());

        let first = test
            .commands
            .sign_out(request.clone())
            .await
            .expect("the first press is served");
        received_revocations(&server).await;
        let retry = test
            .commands
            .sign_out(request)
            .await
            .expect("the retry is answered");

        assert_eq!(first, EmptyPayload {});
        assert_eq!(retry, EmptyPayload {});
        assert_eq!(lock(&server.revocation_forms).len(), 1);
        assert!(
            harness
                .keychain
                .read(
                    harness
                        .service
                        .custody
                        .test_digest(&address(&server))
                        .await
                        .as_str()
                )
                .await
                .expect("the keychain answers")
                .is_none()
        );
    }

    // Mutations: answer success for a removal the keychain refused, or forget the sign-in in
    // memory before the removal.
    #[tokio::test]
    async fn a_refused_keychain_answers_sign_out_failed() {
        let (server, harness, authorizer) = signed_in(StatusCode::OK, None, None).await;
        let test = commands_over(driver_reaching(&server), &harness.service).await;
        harness.platform_store.refuse_next_call(
            KeychainService::McpSignIns.as_str(),
            harness
                .service
                .custody
                .test_digest(&address(&server))
                .await
                .as_str(),
        );

        let signed_out = test.commands.sign_out(press(&docs_binding())).await;

        let Err(HandlerError::Refused(refusal)) = signed_out else {
            unreachable!("the refused removal refuses the sign-out");
        };
        assert_eq!(refusal.code, RefusalCode::McpServerSignOutFailed);
        assert_eq!(
            refusal
                .detail
                .as_ref()
                .and_then(|detail| detail.get("cause")),
            Some(&json!(KeychainRefusalCause::Unavailable))
        );
        assert_eq!(
            presented_authorization(&authorizer, &server.base)
                .await
                .as_deref(),
            Some("Bearer test-access-token-1")
        );
        assert!(
            harness
                .keychain
                .read(
                    harness
                        .service
                        .custody
                        .test_digest(&address(&server))
                        .await
                        .as_str()
                )
                .await
                .expect("the keychain answers")
                .is_some(),
            "the item is still kept"
        );
        assert!(lock(&server.revocation_forms).is_empty());
    }

    /// A binding no sign-in reaches.
    #[derive(Clone, Copy, Debug)]
    enum UnreachedBinding {
        /// A program the provider starts.
        Program,
        /// A connector of the test account.
        Connector,
    }

    // Killed by a sign-out answered success where no sign-in can exist, and for a connector by
    // the connector check moved below `read_declarations` in `SignInTargetReads::read`.
    #[rstest]
    #[case::program(UnreachedBinding::Program)]
    #[case::connector(UnreachedBinding::Connector)]
    #[tokio::test]
    async fn a_binding_no_sign_in_reaches_is_refused_and_removes_nothing(
        #[case] case: UnreachedBinding,
    ) {
        let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
        let docs = docs_binding();
        let (binding, mut driver) = match case {
            UnreachedBinding::Program => (
                docs.clone(),
                driver_declaring(vec![program_declaration(&docs)]),
            ),
            UnreachedBinding::Connector => {
                let connector = McpServerBindingRef::Connector {
                    provider: docs.provider().clone(),
                    scope_ref: test_provider_account_id(),
                    server_name: docs.server_name().clone(),
                };
                // No inventory read can happen: the target read refuses a connector first, and no
                // pending pass reads one, since none is started and none is owed.
                let mut driver = MockProviderDriver::new();
                driver.expect_read_mcp_servers().times(0);
                (connector, driver)
            }
        };
        driver.expect_read_mcp_server_addresses().times(0);
        let test = commands_over(Arc::new(driver), &harness.service).await;

        let signed_out = test.commands.sign_out(press(&binding)).await;

        let Err(HandlerError::Refused(refusal)) = signed_out else {
            unreachable!("no sign-in reaches the binding");
        };
        assert_eq!(refusal.code, RefusalCode::McpServerSignInUnsupported);
        assert!(
            harness
                .keychain
                .read(
                    harness
                        .service
                        .custody
                        .test_digest(&address(&server))
                        .await
                        .as_str()
                )
                .await
                .expect("the keychain answers")
                .is_some(),
            "the sign-in held at the address stays"
        );
    }

    /// What a sign-out's address read finds.
    #[derive(Clone, Copy, Debug)]
    enum SignOutAddress {
        /// The address, with a metadata address no sign-in can use.
        UnusableMetadata,
        /// No address any more, after one was read.
        UnreadableAfterARead,
        /// No address, and none ever read.
        NeverRead,
    }

    // A held sign-in is removable whatever its entry now says: a metadata address a sign-in
    // refuses does not refuse the sign-out, and an address that no longer reads signs out the
    // server it last read as; one never read is refused and removes nothing. Killed by the
    // sign-out reading the sign-in's target (`UnusableMetadata` refused), by an unreadable address
    // refused in place of its last digest, and by a sign-out of nothing answered success.
    #[rstest]
    #[case::unusable_metadata(SignOutAddress::UnusableMetadata)]
    #[case::unreadable_after_a_read(SignOutAddress::UnreadableAfterARead)]
    #[case::never_read(SignOutAddress::NeverRead)]
    #[tokio::test]
    async fn a_held_sign_in_signs_out_however_its_entry_now_reads(#[case] case: SignOutAddress) {
        let (server, harness, _authorizer) = signed_in(StatusCode::OK, None, None).await;
        let mut declaration = remote_declaration(&docs_binding(), &server.base);
        declaration.sign_in_settings = Some(McpServerSignInSettings {
            client_id: None,
            callback_url: None,
            callback_port: None,
            authorization_server_metadata_url: Some("http://metadata.example.test/".to_owned()),
            asks_offline_access_where_listed: false,
        });
        let mut driver = driver_declaring(vec![declaration]);
        answer_address_read(
            &mut driver,
            Ok(match case {
                SignOutAddress::UnusableMetadata => {
                    McpServerAddressReading::Declared(address(&server))
                }
                SignOutAddress::UnreadableAfterARead | SignOutAddress::NeverRead => {
                    McpServerAddressReading::Unreadable
                }
            }),
        );
        let test = commands_over(Arc::new(driver), &harness.service).await;
        if matches!(case, SignOutAddress::UnreadableAfterARead) {
            test.commands
                .owed
                .note_declared(&docs_binding(), &address(&server))
                .await
                .expect("the address read is kept");
        }

        let signed_out = test.commands.sign_out(press(&docs_binding())).await;

        let is_signed_out = !matches!(case, SignOutAddress::NeverRead);
        match &signed_out {
            Ok(_) => assert!(is_signed_out, "a sign-out of nothing is refused"),
            Err(HandlerError::Refused(refusal)) => {
                assert!(!is_signed_out, "{refusal:?}");
                assert_eq!(refusal.code, RefusalCode::McpServerSignInUnsupported);
            }
            Err(error) => panic!("the sign-out failed: {error:?}"),
        }
        assert_eq!(
            harness
                .keychain
                .read(
                    harness
                        .service
                        .custody
                        .test_digest(&address(&server))
                        .await
                        .as_str()
                )
                .await
                .expect("the keychain answers")
                .is_none(),
            is_signed_out
        );
    }
}
