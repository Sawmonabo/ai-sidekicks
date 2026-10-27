//! The person's session link verbs: `session.link.add` and `session.link.remove` for a `related`
//! link, and `session.relatedSession.subscribe`, a session's ranked related list, live. The
//! subscription's first emission is the whole list, read before the call is answered, and each
//! later one the whole list again once the ranking says it may read differently; a slow reader
//! is sent only the newest list.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::links::{
    SessionLinkAdd, SessionLinkRemove, SessionLinkRequest, SessionRelatedListUpdate,
    SessionRelatedSessionSubscribe, SessionRelatedSessionSubscribeRequest,
};

use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::{LatestValueFeed, LatestValueOutlet};
use sidekicks_session::links::service::SessionLinkService;
use sidekicks_session::related::ranking::SessionRelatedRanking;

/// Registers the two link verbs and `session.relatedSession.subscribe`, each refusing by the codes
/// its method lists, a refused subscription leaving nothing open. Fails the start when a method is
/// already registered.
pub(crate) fn register_session_links(
    registry: &mut MethodRegistryBuilder,
    links: Arc<SessionLinkService>,
    ranking: Arc<SessionRelatedRanking>,
) -> Result<(), RegistrationError> {
    let adding = Arc::clone(&links);
    registry.register::<SessionLinkAdd, _>(
        move |request: SessionLinkRequest, _context: HandlerContext| {
            let links = Arc::clone(&adding);
            async move {
                links.add(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    let removing = links;
    registry.register::<SessionLinkRemove, _>(
        move |request: SessionLinkRequest, _context: HandlerContext| {
            let links = Arc::clone(&removing);
            async move {
                links.remove(&request).await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )?;
    registry.register_subscription::<SessionRelatedSessionSubscribe, _>(
        move |request: SessionRelatedSessionSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let ranking = Arc::clone(&ranking);
            async move {
                let feed = LatestValueFeed::open(|outlet| {
                    follow_related_list(ranking, request.session_id, outlet)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = SessionRelatedListUpdate>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Sends `session_id`'s list through `outlet` now, then again each time the ranking raises the
/// list's count, until the returned detach runs. The first read's failure is the subscribe call's;
/// a later one ends the stream with that failure, a refusal or a fault, and the read pool closing
/// under the daemon's stop ends it finished.
async fn follow_related_list(
    ranking: Arc<SessionRelatedRanking>,
    session_id: SessionId,
    outlet: LatestValueOutlet<SessionRelatedListUpdate>,
) -> Result<impl FnOnce() + Send, HandlerError> {
    // Taken before the first read, so a raise while it reads makes one more read, never a miss.
    let mut count = ranking.follow(&session_id);
    outlet.send(ranking.read(session_id).await?);
    let following = tokio::spawn(async move {
        while count.changed().await.is_ok() {
            match ranking.read(session_id).await {
                Ok(list) => outlet.send(list),
                Err(failure) if failure.is_pool_closed() => return,
                Err(failure) => {
                    outlet.fail(failure.into());
                    return;
                }
            }
        }
    });
    Ok(move || following.abort())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::session::links::{
        SessionLinkAdd, SessionRelatedListUpdate, SessionRelatedSessionSubscribe,
    };

    use super::register_session_links;
    use crate::remote::shared_ports::schema::schema_parts;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::registry::{
        Dispatch as _, DispatchError, EncodedFeed, MethodRegistryBuilder, Reply,
    };
    use sidekicks_ipc::stream::feed::CreditGate;
    use sidekicks_session::links::service::{
        SESSION_LINK_SERVICE_STATEMENT_CAPACITY, SessionLinkService,
    };
    use sidekicks_session::related::ranking::{
        RELATED_RANKING_STATEMENT_CAPACITY, SessionRelatedRanking,
    };
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::tests::open_log;

    /// Long enough for a re-score round to store and raise, many times over.
    const ROUND_WAIT: Duration = Duration::from_secs(10);

    /// The related sessions the next emission lists.
    async fn next_related(feed: &mut Box<dyn EncodedFeed>, gate: &CreditGate) -> Vec<SessionId> {
        let value = tokio::time::timeout(ROUND_WAIT, feed.next(gate))
            .await
            .expect("an emission comes")
            .expect("the list reads")
            .expect("the stream goes on");
        let update: SessionRelatedListUpdate =
            serde_json::from_slice(&value.json).expect("the emission reads as its type");
        update
            .related
            .into_iter()
            .map(|entry| entry.session_id)
            .collect()
    }

    #[tokio::test]
    async fn the_related_list_comes_whole_first_and_whole_again_after_a_rescore() {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let (followed, first, second) = (test_session_id(), test_session_id(), test_session_id());
        let reader = database.reader();
        for session_id in [followed, first, second] {
            insert_session_row(&reader, session_id.text().as_str(), None, None);
        }
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            RELATED_RANKING_STATEMENT_CAPACITY + SESSION_LINK_SERVICE_STATEMENT_CAPACITY,
        ));
        let ranking = Arc::new(SessionRelatedRanking::new(
            Arc::clone(&reads),
            Arc::clone(&log.writer),
        ));
        let rescoring = ranking.start(&log.followers);
        let links = Arc::new(SessionLinkService::new(
            reads,
            Arc::clone(&log.writer),
            Arc::clone(&ranking),
        ));
        let mut builder = MethodRegistryBuilder::new();
        register_session_links(&mut builder, links, Arc::clone(&ranking))
            .expect("the link methods register");
        let registry = builder.freeze();
        let subscribe = |session_id: SessionId| {
            registry.dispatch(
                request(
                    SessionRelatedSessionSubscribe::DESCRIPTOR.method,
                    Some(&json!({ "sessionId": session_id })),
                ),
                context(1),
            )
        };

        let refused = subscribe(test_session_id()).await;
        let Err(DispatchError::Refused(refusal)) = refused else {
            panic!("a session the daemon does not hold is refused before anything opens");
        };
        assert_eq!(refusal.code, RefusalCode::SessionNotFound);
        assert_eq!(
            ranking.open_follow_count(),
            0,
            "the refused subscribe follows nothing"
        );

        let Ok(Reply::Subscription { mut feed, .. }) = subscribe(followed).await else {
            panic!("a held session's subscribe answers a subscription");
        };
        let gate = CreditGate::with_credit(1);
        assert_eq!(
            next_related(&mut feed, &gate).await,
            Vec::<SessionId>::new()
        );

        let link = |target: SessionId| {
            registry.dispatch(
                request(
                    SessionLinkAdd::DESCRIPTOR.method,
                    Some(&json!({ "sessionId": followed, "targetSessionId": target })),
                ),
                context(1),
            )
        };
        assert!(link(first).await.is_ok(), "the first link is added");
        assert_eq!(next_related(&mut feed, &gate).await, [first]);
        assert!(link(second).await.is_ok(), "the second link is added");
        let mut whole = next_related(&mut feed, &gate).await;
        whole.sort_by_key(|session_id| session_id.text().as_str().to_owned());
        let mut expected = vec![first, second];
        expected.sort_by_key(|session_id| session_id.text().as_str().to_owned());
        assert_eq!(whole, expected, "the second emission is the whole list");

        drop(feed);
        rescoring.stop().await.expect("the re-scoring task ends");
    }
}
