//! Writes the folder the TypeScript generator reads: per contract module its closed JSON Schema and
//! what it exports besides its types, and the refusal codes once. A development program, run as
//! `cargo run -p sidekicks-contracts --example emit -- <folder>`; it is never shipped.

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::{MethodTable, ProcedureType};
use sidekicks_contracts::schema::{close_composite_objects, generator};
use sidekicks_contracts::typescript::{SchemaContract, TypeName, TypeScriptModule};

/// The scheme of every module schema's `$id` and of a reference into another module.
const MODULE_ID_SCHEME: &str = "sidekicks-contracts:";
/// Where schemars puts a definition, as a local reference reads it.
const LOCAL_DEFINITIONS: &str = "#/$defs/";

/// What every emit step returns: its value, or the error that stops the run.
type EmitResult<T> = Result<T, Box<dyn Error>>;

fn main() -> EmitResult<()> {
    let folder = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: cargo run -p sidekicks-contracts --example emit -- <folder>")?;
    let modules: Vec<&TypeScriptModule> = sidekicks_contracts::typescript_modules().collect();
    let owners = definition_owners(&modules)?;
    for module in &modules {
        write_module(&folder, module, &owners)?;
    }
    write_json(
        &folder.join("refusal-codes.json"),
        &json!({
            "module": RefusalCode::TYPESCRIPT_MODULE_PATH,
            "name": "RefusalCode",
            "doc": "Every refusal code a daemon method or a control plane route answers with.",
            "codes": RefusalCode::ALL.iter().map(|code| code.as_str()).collect::<Vec<_>>(),
        }),
    )?;
    writeln!(
        std::io::stdout().lock(),
        "wrote {} contract modules and {} refusal codes into {}",
        modules.len(),
        RefusalCode::ALL.len(),
        folder.display()
    )?;
    Ok(())
}

/// Each definition's name and the module that owns it; refuses a name two modules claim.
fn definition_owners(modules: &[&TypeScriptModule]) -> EmitResult<HashMap<String, &'static str>> {
    let mut owners = HashMap::new();
    for module in modules {
        for definition in module.definitions {
            let name = (definition.name)().into_owned();
            if let Some(other) = owners.insert(name.clone(), module.path) {
                return Err(
                    format!("{name} is defined in both {other} and {}", module.path).into(),
                );
            }
        }
    }
    Ok(owners)
}

/// Writes one module's `schema.json` and `module.json`.
fn write_module(
    folder: &Path,
    module: &TypeScriptModule,
    owners: &HashMap<String, &'static str>,
) -> EmitResult<()> {
    let mut generators = [
        generator(SchemaContract::Read),
        generator(SchemaContract::Sent),
    ];
    let generator_index = |contract| match contract {
        SchemaContract::Read => 0,
        SchemaContract::Sent => 1,
    };
    let mut definitions = Map::new();
    for definition in module.definitions {
        let generator = &mut generators[generator_index(definition.contract)];
        let mut schema = (definition.schema)(generator);
        // The generator's transforms run on what it collects; a listed schema takes them too, so
        // the two compare equal.
        for transform in generator.transforms_mut() {
            transform.transform(&mut schema);
        }
        definitions.insert((definition.name)().into_owned(), schema.to_value());
    }
    for (contract, generator) in [SchemaContract::Read, SchemaContract::Sent]
        .into_iter()
        .zip(&mut generators)
    {
        for (name, schema) in generator.take_definitions(true) {
            match owners.get(&name) {
                Some(owner) if *owner != module.path => {}
                Some(_) => {
                    let listed = definitions
                        .get(&name)
                        .ok_or("a listed definition is present")?;
                    if *listed != schema {
                        return Err(format!(
                            "{}: {name}'s {contract:?} schema differs from its listed one",
                            module.path
                        )
                        .into());
                    }
                }
                None => {
                    return Err(format!(
                        "{}: {name} has a schema definition, but no module lists it",
                        module.path
                    )
                    .into());
                }
            }
        }
    }
    for (name, schema) in &definitions {
        if schema
            .get("description")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(
                format!("{}: {name} has no description (its `///` doc)", module.path).into(),
            );
        }
    }

    let mut document = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": format!("{MODULE_ID_SCHEME}{}", module.path),
        "$defs": definitions,
    });
    close_composite_objects(&mut document);
    point_references_at_owners(&mut document, module.path, owners)?;

    let method_tables = module
        .method_tables
        .iter()
        .map(|table| method_table_json(table, module.path, owners))
        .collect::<EmitResult<Vec<_>>>()?;
    let mut checks: Vec<String> = module
        .definitions
        .iter()
        .filter(|definition| definition.is_checked)
        .map(|definition| (definition.name)().into_owned())
        .collect();
    checks.sort();
    let constants = module
        .constants
        .iter()
        .map(|constant| {
            let value = (constant.value)()?;
            Ok(json!({ "name": constant.name, "doc": doc_text(constant.doc), "value": value }))
        })
        .collect::<EmitResult<Vec<_>>>()?;

    let module_folder = folder.join("modules").join(module.path);
    fs::create_dir_all(&module_folder)?;
    write_json(&module_folder.join("schema.json"), &document)?;
    write_json(
        &module_folder.join("module.json"),
        &json!({
            "doc": doc_text(module.doc),
            "checks": checks,
            "constants": constants,
            "methodTables": method_tables,
        }),
    )
}

/// Points every reference to another module's definition at that module:
/// `#/$defs/Name` becomes `sidekicks-contracts:<owner>#/$defs/Name`.
fn point_references_at_owners(
    schema: &mut Value,
    module_path: &str,
    owners: &HashMap<String, &'static str>,
) -> EmitResult<()> {
    match schema {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref") {
                let name = reference
                    .strip_prefix(LOCAL_DEFINITIONS)
                    .ok_or_else(|| format!("{module_path}: unexpected reference {reference}"))?;
                let owner = owners
                    .get(name)
                    .ok_or_else(|| format!("{module_path}: {name} is referenced, never listed"))?;
                if *owner != module_path {
                    *reference = format!("{MODULE_ID_SCHEME}{owner}{LOCAL_DEFINITIONS}{name}");
                }
            }
            object
                .values_mut()
                .try_for_each(|value| point_references_at_owners(value, module_path, owners))
        }
        Value::Array(items) => items
            .iter_mut()
            .try_for_each(|value| point_references_at_owners(value, module_path, owners)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
    }
}

/// One method table as `module.json` lists it, each type named locally or as `<module>#Name`.
fn method_table_json(
    table: &MethodTable,
    module_path: &str,
    owners: &HashMap<String, &'static str>,
) -> EmitResult<Value> {
    let reference = |type_name: TypeName| -> EmitResult<String> {
        let name = (type_name.0)().into_owned();
        let owner = owners
            .get(&name)
            .ok_or_else(|| format!("{}: method type {name} is listed by no module", table.name))?;
        Ok(if *owner == module_path {
            name
        } else {
            format!("{owner}#{name}")
        })
    };
    let methods = table
        .methods
        .iter()
        .map(|method| {
            let mut entry = BTreeMap::from([
                ("method", json!(method.method)),
                (
                    "procedureType",
                    json!(match method.procedure_type {
                        ProcedureType::Query => "query",
                        ProcedureType::Mutation => "mutation",
                        ProcedureType::Subscription => "subscription",
                    }),
                ),
                ("mutating", json!(method.is_mutating)),
                ("params", json!(reference(method.params)?)),
                ("result", json!(reference(method.result)?)),
            ]);
            if let Some(emission) = method.emission {
                entry.insert("emission", json!(reference(emission)?));
            }
            Ok(json!(entry))
        })
        .collect::<EmitResult<Vec<_>>>()?;
    let mut table_json =
        json!({ "name": table.name, "doc": doc_text(table.doc), "methods": methods });
    if let Some(type_name) = table.type_name {
        table_json["typeName"] = json!(type_name);
    }
    Ok(table_json)
}

/// A doc as the generator writes it: `///` lines arrive with their leading space and a trailing
/// line break each.
fn doc_text(doc: &str) -> String {
    doc.lines()
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// Writes `value` to `path` as pretty JSON ending in a newline.
fn write_json(path: &Path, value: &Value) -> EmitResult<()> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    fs::write(path, text)?;
    Ok(())
}
