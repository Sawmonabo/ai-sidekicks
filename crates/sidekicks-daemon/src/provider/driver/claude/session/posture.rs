//! Compares the posture a session was started with against the one a run asks for, and digests the
//! output schema so a change is noticed.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;

use sidekicks_store::events::canonicalizer::{CanonicalizationRefusal, canonicalize_json};

/// Names the first axis a spawn binds on which a run differs from its session's spawn posture,
/// with both values, or `None` when none does: the credential policy strictly, then the writable
/// roots in any order but each as often. `mode` is no such axis, since a live level move changes
/// it in the running process.
pub(crate) fn find_posture_divergence(
    run_posture: &ExecutionPosture,
    spawn_posture: &ExecutionPosture,
) -> Option<String> {
    let run_policy = run_posture.credential_policy_ref();
    let spawn_policy = spawn_posture.credential_policy_ref();
    if run_policy != spawn_policy {
        return Some(format!(
            "credentialPolicyRef (run {}, session {})",
            run_policy.as_str(),
            spawn_policy.as_str()
        ));
    }
    let run_roots = run_posture.writable_roots();
    let spawn_roots = spawn_posture.writable_roots();
    if do_writable_roots_differ(run_roots, spawn_roots) {
        return Some(format!(
            "writableRoots (run {}, session {})",
            write_roots_as_json(run_roots),
            write_roots_as_json(spawn_roots)
        ));
    }
    None
}

/// The lower-case hex SHA-256 of an output schema's canonical JSON bytes: key order does not change
/// it, array order does (it is meaningful in JSON Schema, as in `prefixItems`). Returns the
/// canonicalizer's refusal for a schema with no canonical form.
pub(crate) fn digest_output_schema(
    output_schema: &Map<String, Value>,
) -> Result<String, CanonicalizationRefusal> {
    let bytes = canonicalize_json(&Value::Object(output_schema.clone()))?;
    Ok(base16ct::lower::encode_string(&Sha256::digest(
        bytes.as_bytes(),
    )))
}

// Order-insensitive but multiplicity-sensitive: a duplicated root is a different declaration.
fn do_writable_roots_differ(run_roots: &[FilesystemPath], spawn_roots: &[FilesystemPath]) -> bool {
    if run_roots.len() != spawn_roots.len() {
        return true;
    }
    let mut sorted_run: Vec<&FilesystemPath> = run_roots.iter().collect();
    let mut sorted_spawn: Vec<&FilesystemPath> = spawn_roots.iter().collect();
    sorted_run.sort_unstable();
    sorted_spawn.sort_unstable();
    sorted_run != sorted_spawn
}

fn write_roots_as_json(roots: &[FilesystemPath]) -> String {
    Value::Array(
        roots
            .iter()
            .map(|root| Value::String(root.as_str().to_owned()))
            .collect(),
    )
    .to_string()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::provider::driver::capabilities::{
        CredentialPolicyRef, ExecutionPosture,
    };

    use super::{digest_output_schema, find_posture_divergence};

    fn posture(credential_policy: &str, roots: &[&str]) -> ExecutionPosture {
        ExecutionPosture::Ask {
            credential_policy_ref: CredentialPolicyRef::new(credential_policy.to_owned()).unwrap(),
            writable_roots: roots
                .iter()
                .map(|root| FilesystemPath::new((*root).to_owned()).unwrap())
                .collect(),
        }
    }

    #[rstest]
    #[case::reordered_roots_agree("curated", &["/a", "/b"], "curated", &["/b", "/a"], None)]
    #[case::a_duplicated_root_differs(
        "curated",
        &["/a", "/a", "/b"],
        "curated",
        &["/a", "/b", "/b"],
        Some(r#"writableRoots (run ["/a","/a","/b"], session ["/a","/b","/b"])"#)
    )]
    #[case::another_credential_policy_differs(
        "curated",
        &["/a"],
        "strict",
        &["/a"],
        Some("credentialPolicyRef (run curated, session strict)")
    )]
    fn names_the_axis_a_run_differs_on(
        #[case] run_policy: &str,
        #[case] run_roots: &[&str],
        #[case] spawn_policy: &str,
        #[case] spawn_roots: &[&str],
        #[case] expected: Option<&str>,
    ) {
        let divergence = find_posture_divergence(
            &posture(run_policy, run_roots),
            &posture(spawn_policy, spawn_roots),
        );

        assert_eq!(divergence.as_deref(), expected);
    }

    #[test]
    fn digests_a_schema_by_its_array_order_and_not_its_key_order() {
        let digest = |schema: Value| {
            digest_output_schema(schema.as_object().unwrap()).expect("the schema is canonical")
        };
        let schema = digest(json!({"type": "array", "prefixItems": [{"type": "string"}, {}]}));

        assert_eq!(
            schema,
            digest(json!({"prefixItems": [{"type": "string"}, {}], "type": "array"}))
        );
        assert_ne!(
            schema,
            digest(json!({"type": "array", "prefixItems": [{}, {"type": "string"}]}))
        );
    }
}
