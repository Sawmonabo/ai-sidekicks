//! A step's launch, which its driver runs before the step's executor or agent run starts: before
//! its turn in the memory gate's line for a step that waits at the gate or makes its own run, and
//! after the dispatch admits it for any other. Its secrets resolve, its params are read and its
//! templates opened on the expression thread, and its context is built.

use std::sync::Arc;

use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use tokio_util::sync::CancellationToken;

use super::StepDispatch;
use crate::engine::event_record::EngineFault;
use crate::engine::ports::WorkflowNodeKey;
use crate::engine::tick::node_settings::main_inputs;
use crate::engine::tick::{ReadyStep, RunScope, RunSnapshot};
use crate::expressions::bindings::ExpressionBindings;
use crate::expressions::lineage::StepKey;
use crate::kinds::step_context::{StepContext, StepContextParts, StepParams};
use crate::kinds::{NodeKind, StepFailure, uncoded_step_error};
use crate::secrets::resolution::resolve_node_secrets;

impl StepDispatch {
    /// Launches `ready`, a step of kind `kind` in the run of `scope`, reading `snapshot`: resolves
    /// its node's secrets, reads its params, opens its templates on the expression thread when it
    /// has any, and builds its context around `cancel`, holding no place at the memory gate yet.
    /// Its inputs arrive already cut for an execute-once node. Reports nothing; fails
    /// with [`StepFailure::Failed`] when a secret, a param or a template does, recording a failed
    /// keychain or secret read with its causes in the engine's record first.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) async fn launch(
        &self,
        scope: &RunScope,
        snapshot: &RunSnapshot,
        ready: &ReadyStep,
        kind: &NodeKind,
        cancel: CancellationToken,
    ) -> Result<StepContext, StepFailure> {
        let node = scope
            .nodes
            .get(&ready.step.node_id)
            .expect("the step's driver looked its node up in the run's nodes");
        let resolved = resolve_node_secrets(
            &self.reads,
            &self.secrets,
            scope.project.as_ref(),
            &kind.spec,
            &node.params,
        )
        .await;
        let secrets = match resolved {
            Ok(secrets) => secrets,
            Err(refusal) => {
                if refusal.has_failure_underneath() {
                    self.record_fault(scope, &ready.step, EngineFault::SecretReadFailed, &refusal)
                        .await;
                }
                return Err(StepFailure::Failed(Box::new(refusal.into())));
            }
        };
        let (params, templates) = StepParams::read(&node.params).map_err(|refusal| {
            StepFailure::Failed(Box::new(uncoded_step_error(refusal.to_string())))
        })?;
        let expressions = if templates.is_empty() {
            None
        } else {
            let input_items: Arc<[WorkflowItem]> = main_inputs(&kind.spec, &ready.inputs)
                .next()
                .map_or_else(|| Arc::from([]), |items| Arc::from(items.as_slice()));
            let bindings = ExpressionBindings {
                step: StepKey {
                    node_id: ready.step.node_id.clone(),
                    execution_index: ready.step.execution_index.get(),
                },
                input_items,
                steps: Arc::clone(&snapshot.outputs),
                node_params: Arc::clone(&scope.node_params),
                run_index: ready.run_index,
                run_started_at: scope.run_started_at,
                time_zone: scope.time_zone.clone(),
                environment_rows: Arc::clone(&scope.environment_rows),
                run_variables: Arc::clone(&snapshot.run_variables),
                kept_values: Arc::clone(&scope.kept_values),
                run_id: scope.run_id,
                run_trigger: scope.trigger.clone(),
                workflow_id: scope.workflow_id,
                workflow_name: scope.workflow_name.clone(),
            };
            let opened = self
                .evaluator
                .open_step(bindings, templates, &cancel)
                .await
                .map_err(|error| {
                    StepFailure::Failed(Box::new(uncoded_step_error(error.to_string())))
                })?;
            Some(opened)
        };
        Ok(StepContext::new(StepContextParts {
            session_id: scope.session_id,
            step: ready.step.clone(),
            node_key: WorkflowNodeKey::new(scope.workflow_id, &node.id),
            node_name: node.name.clone(),
            run_index: ready.run_index,
            permission_level: snapshot.permission_level,
            working_folder: scope.working_folder.clone(),
            provider: scope.provider.clone(),
            secrets,
            cancel,
            redaction: Arc::clone(&scope.redaction),
            admission: None,
            step_actions: Arc::clone(&self.ports.step_actions),
            processes: Arc::clone(&self.ports.processes),
            payloads: Arc::clone(&self.ports.payloads),
            http: self.http.clone(),
            params,
            expressions,
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::workflow::definition::document::WorkflowNode;
    use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use tokio::time::timeout;
    use tokio_util::sync::CancellationToken;

    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;

    use super::super::tests::WAIT;
    use super::super::{
        test_dispatch, test_dispatch_recording, test_ready_step, test_run_snapshot,
    };
    use crate::engine::event_record::{EngineFault, EngineRecorder};
    use crate::engine::ports::{
        EngineRecordSink, KeptEngineRecords, WorkflowNodeKey, refusing_engine_ports,
    };
    use crate::engine::tick::{RunScope, test_run_scope};
    use crate::kinds::step_context::StepContext;
    use crate::kinds::{NodeKind, NodeKindTable, PassThroughExecutor, StepFailure, test_kind};
    use crate::schema::schema_parts;
    use crate::secrets::resolution::STEP_SECRET_STATEMENT_CAPACITY;

    /// A kind whose inputs are a tool input, then a main one, and whose `token` param is
    /// sensitive.
    fn tool_then_main_kind() -> NodeKind {
        test_kind(
            json!({
                "kind": "test.greet", "version": 1, "category": "developer",
                "displayName": "Greet", "description": "A test kind.", "icon": "test",
                "outputsDeriveFromParams": false,
                "inputs": [
                    { "type": "tool", "id": "inputs/tool/0", "label": "Tool" },
                    { "type": "main", "id": "inputs/main/0", "label": "In" },
                ],
                "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
                "params": [
                    { "id": "token", "label": "Token", "type": "string", "sensitive": true },
                ],
            }),
            None,
            Box::new(PassThroughExecutor),
        )
    }

    /// The node `greet` of the test kind holding `params`.
    fn greet_node(params: &Value) -> WorkflowNode {
        serde_json::from_value(json!({
            "id": "greet", "kind": "test.greet", "kindVersion": 1, "name": "Greet", "order": 0,
            "params": params,
        }))
        .expect("the test's node reads")
    }

    /// Launches the first execution of `node`, the run's one node, over `inputs` in a manual run,
    /// returning the run's scope with the launch's answer.
    async fn launch(
        database: &TestDatabase,
        node: WorkflowNode,
        inputs: Vec<Vec<Value>>,
    ) -> (RunScope, Result<StepContext, StepFailure>) {
        let scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
        let snapshot = test_run_snapshot(&node);
        let ready = test_ready_step(&scope, &node, inputs);
        let (dispatch, _reports) = test_dispatch(database, Vec::new());
        let launched = timeout(
            WAIT,
            dispatch.launch(
                &scope,
                &snapshot,
                &ready,
                &tool_then_main_kind(),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("the launch answers in time");
        (scope, launched)
    }

    /// A templated step evaluates its templates over the items of its first main input, past a
    /// tool input listed before it, keeps its literals, and keys its node by the workflow and the
    /// node's id on the run's provider. Mutations: read the first list as the main input; leave
    /// the expressions unopened; key the node by another id.
    #[tokio::test]
    async fn a_templated_launch_reads_the_first_main_input() {
        let database = TestDatabase::new(schema_parts());
        let node = greet_node(&json!({ "greeting": "={{ $json.name }}", "fixed": "x" }));

        let (scope, launched) = launch(
            &database,
            node.clone(),
            vec![
                Vec::new(),
                vec![json!({ "name": "Ada" }), json!({ "name": "Bob" })],
            ],
        )
        .await;

        let context = launched.expect("the step launches");
        for (item_index, name) in [(0, "Ada"), (1, "Bob")] {
            let params = timeout(WAIT, context.item_params(item_index))
                .await
                .expect("the evaluation answers in time")
                .expect("the item's params evaluate");
            assert_eq!(
                Value::Object(Map::clone(&params)),
                json!({ "greeting": name, "fixed": "x" })
            );
        }
        assert_eq!(
            context.node_key,
            WorkflowNodeKey::new(scope.workflow_id, &node.id)
        );
        assert_eq!(context.provider, scope.provider);
    }

    /// A template never closed fails the step with no code, naming its path, and a sensitive
    /// reference no record holds fails it as `workflow.secret.notFound`, naming the reference.
    /// Mutations: pass the secret refusal on with no code; run the unclosed template as text.
    #[rstest]
    #[case::unclosed_template(
        json!({ "bad": "={{ a" }),
        json!({ "message": "the template at bad is never closed" }),
    )]
    #[case::missing_secret(
        json!({ "token": "secret://shared/missing" }),
        json!({
            "message": "No secret is stored for secret://shared/missing.",
            "code": "workflow.secret.notFound",
            "details": { "reference": "secret://shared/missing" },
        }),
    )]
    #[tokio::test]
    async fn a_launch_refusal_fails_the_step(#[case] params: Value, #[case] expected: Value) {
        let database = TestDatabase::new(schema_parts());
        drop(database.opener()().expect("the test creates its database"));

        let (_scope, launched) = launch(&database, greet_node(&params), vec![Vec::new()]).await;

        let Err(StepFailure::Failed(error)) = launched else {
            panic!("the launch fails the step");
        };
        assert_eq!(
            serde_json::to_value(error).expect("a step failure writes"),
            expected
        );
    }

    /// A secret whose record cannot be read fails the step, and the failure goes to the engine's
    /// record with its causes, not its top message alone, in the record the run start wrote the
    /// run's earlier line in: the same life, the run's next sequence. Mutations: skip the record;
    /// record only the top message; build the dispatch a recorder of its own.
    #[tokio::test]
    async fn a_failed_secret_read_goes_to_the_record_with_its_causes() {
        const OPEN_FAILED: &str = "a read-only connection to the database could not be opened: ";
        let database = TestDatabase::new(schema_parts());
        let node = greet_node(&json!({ "token": "secret://shared/deploy-key" }));
        let scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
        let ready = test_ready_step(&scope, &node, vec![Vec::new()]);
        let sink = Arc::new(KeptEngineRecords::default());
        let recorder = Arc::new(EngineRecorder::new(
            Arc::clone(&sink) as Arc<dyn EngineRecordSink>
        ));
        recorder
            .for_run(scope.run_id, Arc::clone(&scope.redaction))
            .fault(
                None,
                EngineFault::HeldStartLeftBehind,
                &std::io::Error::other("the start's line"),
            )
            .await;
        let (mut dispatch, _reports, _sender) = test_dispatch_recording(
            &database,
            refusing_engine_ports(),
            Arc::new(NodeKindTable::new(Vec::new()).expect("an empty table builds")),
            recorder,
        );
        dispatch.reads = Arc::new(DatabaseReadPool::new(
            database.path().with_file_name("missing.sqlite3"),
            STEP_SECRET_STATEMENT_CAPACITY,
        ));

        let launched = timeout(
            WAIT,
            dispatch.launch(
                &scope,
                &test_run_snapshot(&node),
                &ready,
                &tool_then_main_kind(),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("the launch answers in time");

        assert!(matches!(launched, Err(StepFailure::Failed(_))));
        let lines = sink.lines();
        let [start_line, fault] = lines.as_slice() else {
            panic!("the start's line and one fault are recorded: {lines:?}");
        };
        assert_eq!(fault["record"], json!("secretReadFailed"));
        assert_eq!(fault["lifeId"], start_line["lifeId"]);
        assert_eq!(fault["sequence"], json!(2));
        let error = fault["error"].as_str().expect("the error is text");
        assert!(
            error.starts_with(OPEN_FAILED) && error.len() > OPEN_FAILED.len(),
            "the record lacks the failure's causes: {error}"
        );
    }
}
