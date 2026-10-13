//! Artifacts: ids, attachment references, ingest, the manifest, publication and their methods.

use crate::typescript::TypeScriptModule;

pub mod attachment_reference;
pub mod id;
pub mod ingest;
pub mod manifest;
pub mod methods;
pub mod operations;
pub mod publication;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &attachment_reference::TYPESCRIPT_MODULE,
    &id::TYPESCRIPT_MODULE,
    &ingest::TYPESCRIPT_MODULE,
    &manifest::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &operations::TYPESCRIPT_MODULE,
    &publication::TYPESCRIPT_MODULE,
];
