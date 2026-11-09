//! A stand-in program on Windows: an npm-shaped command shim, `name.cmd`, over a Node script,
//! `name.cjs`, with a `node.exe` beside them, which [`program_start`](crate::program_start) runs
//! as the script under that Node, so no `cmd.exe` reads the arguments. The script prints each
//! answer's output byte for byte and records each argument, then each recorded variable's value,
//! as one JSON string a line.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::find_executables;
use crate::stand_in_program::{StandInAnswer, StandInProgram, script_path_text};

/// Writes `program` as the shim `name.cmd` and its script `name.cjs` in `folder`, with this
/// process's `node.exe` linked beside them, and answers the shim's path. Fails as a file fails to
/// write, on a record or hold path that is not UTF-8, and with `NotFound` where this process's
/// `PATH` holds no Node.
pub(crate) fn write_stand_in_script(
    folder: &Path,
    name: &str,
    program: &StandInProgram,
) -> io::Result<PathBuf> {
    let mut answers = Map::new();
    for (word, answer) in &program.answers_by_argument {
        answers.insert(word.clone(), answer_value(answer)?);
    }
    let script = format!(
        "const fs = require(\"fs\");\n\
         const answers = {};\n\
         const otherwise = {};\n\
         const args = process.argv.slice(2);\n\
         const word = Object.keys(answers).find((key) => args.includes(key));\n\
         const answer = word === undefined ? otherwise : answers[word];\n\
         const values = answer.environment.map((name) => process.env[name] ?? \"\");\n\
         const record = args.concat(values).map((line) => JSON.stringify(line) + \"\\n\");\n\
         if (answer.record !== null) fs.appendFileSync(answer.record, record.join(\"\"));\n\
         if (answer.hold !== null) {{\n\
           fs.writeFileSync(answer.hold.waiting, \"\");\n\
           const pause = new Int32Array(new SharedArrayBuffer(4));\n\
           while (!fs.existsSync(answer.hold.release)) Atomics.wait(pause, 0, 0, 50);\n\
         }}\n\
         fs.writeSync(1, answer.output);\n\
         process.exitCode = answer.code;\n",
        Value::Object(answers),
        answer_value(&program.otherwise)?,
    );
    std::fs::write(folder.join(format!("{name}.cjs")), script)?;
    let shim = folder.join(format!("{name}.cmd"));
    std::fs::write(
        &shim,
        format!("@\"%~dp0\\node.exe\"  \"%~dp0\\{name}.cjs\" %*\r\n"),
    )?;
    link_node_beside(folder)?;
    Ok(shim)
}

/// The argument a stand-in recorded as the line `line`, one JSON string. Fails with `InvalidData`
/// on a line that is not one.
pub(crate) fn read_recorded_argument(line: &str) -> io::Result<String> {
    serde_json::from_str(line).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

// One answer as the script's data: its output, its exit code, its record file or `null`, the
// variables it records, and its hold's files or `null`.
fn answer_value(answer: &StandInAnswer) -> io::Result<Value> {
    let record = match &answer.argument_record {
        Some(record) => Value::from(script_path_text(record)?),
        None => Value::Null,
    };
    let hold = match &answer.hold {
        Some(hold) => json!({
            "waiting": script_path_text(&hold.waiting)?,
            "release": script_path_text(&hold.release)?,
        }),
        None => Value::Null,
    };
    Ok(json!({
        "output": answer.standard_output,
        "code": answer.exit_code,
        "record": record,
        "environment": answer.recorded_environment,
        "hold": hold,
    }))
}

// Puts this process's `node.exe` beside the shim, which runs it before any Node on the child's
// own search path: a hard link, or a copy where the folder sits on another volume.
fn link_node_beside(folder: &Path) -> io::Result<()> {
    let beside = folder.join("node.exe");
    if beside.is_file() {
        return Ok(());
    }
    let environment: Vec<(String, String)> = std::env::vars().collect();
    let node = find_executables("node", &environment, Path::new(""), &[])
        .next()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "a stand-in runs under Node, and no node is on this process's search path",
            )
        })?;
    if std::fs::hard_link(&node, &beside).is_err() {
        std::fs::copy(&node, &beside)?;
    }
    Ok(())
}
