//! A project's own Codex config, `<root>/.codex/config.toml`, edited one server's table at a time
//! in place: every comment and every byte outside that table stays as the person wrote it, and the
//! edit lands only while the file still holds what was read, so another program's write between
//! the read and the rename is never lost.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_platforms::{LeftoverSweep, create_file_atomically, flush_folder, real_path};
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_and_flush_while};
use tokio::task::JoinError;
use toml_edit::ser::ValueSerializer;
use toml_edit::{DocumentMut, Item, Table};

use crate::driver::codex::config_read::CODEX_CONFIG_FILE_NAME;
use crate::driver::codex::rules::CODEX_PROJECT_SETTINGS_FOLDER;
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;

/// The mode a project config the daemon makes is created with, less the umask: the person's to
/// edit, the repository's to read, as a file a person makes would be.
const PROJECT_CONFIG_FILE_MODE: u32 = 0o644;

/// One project's Codex config as one read found it, the base an edit is written over. It has no
/// `Debug`, since the config's bytes can hold a server's environment values or token.
pub(super) struct CodexProjectFile {
    /// The `.codex` folder an absent file is made in.
    folder: PathBuf,
    /// The file an edit is written to: the link's target where the config is a link.
    path: PathBuf,
    /// The file's bytes and their hash; `None` where no file stood.
    read: Option<ReadContents>,
}

/// What a read found in a config that stood.
struct ReadContents {
    /// The file's bytes.
    bytes: Vec<u8>,
    /// Their hash, which a fresh read must still match at the rename.
    hash: blake3::Hash,
}

/// One edit to one server's table.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum CodexProjectServerEdit {
    /// Writes each named member with its value, or removes it where the value is `None`; members
    /// not named stay as they are. The table is made where the file has none.
    Set(Vec<(String, Option<Value>)>),
    /// Takes the server's table out.
    Remove,
}

/// What an edit did to the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CodexProjectFileEdit {
    /// The edited file took the old one's place.
    Written,
    /// The edit changes nothing, so nothing was written.
    Unchanged,
    /// The file changed since the read, so nothing was written and it stays as the other writer
    /// left it.
    FileChanged,
}

/// Why a project config could not be read or edited. No variant's words carry a value or the
/// file's text.
#[derive(Debug, thiserror::Error)]
pub(super) enum CodexProjectFileError {
    /// The file stands but could not be read.
    #[error("the project's Codex config could not be read")]
    Read(#[source] io::Error),
    /// The file is not TOML Codex could read, at `line` where the parser names one.
    #[error("the project's Codex config is not valid TOML{}", line_note(*.line))]
    NotToml {
        /// The line, counted from 1, the parser stopped at.
        line: Option<usize>,
    },
    /// The file is a link to a file that does not exist, which an edit cannot make without
    /// writing somewhere the person did not choose.
    #[error("the project's Codex config is a link to a file that does not exist")]
    DanglingLink,
    /// `mcp_servers` is something other than a table, which an edit cannot write into without
    /// taking the person's value away.
    #[error("`mcp_servers` in the project's Codex config is not a table")]
    ServersNotATable,
    /// The server's entry is something other than a table, which an edit cannot write into
    /// without taking the person's value away.
    #[error("the server's entry in the project's Codex config is not a table")]
    ServerEntryNotATable,
    /// A member's value has no TOML form, such as a `null`.
    #[error("the value of `{member}` cannot be written as TOML")]
    UnwritableValue {
        /// The member whose value was refused.
        member: String,
        /// The serializer's refusal, which names the value's kind, never the value.
        #[source]
        failure: toml_edit::ser::Error,
    },
    /// Making the `.codex` folder failed; no file was made.
    #[error("the project's `.codex` folder could not be made")]
    Folder(#[source] io::Error),
    /// The file was made, but flushing the `.codex` folder, or the project's folder after a new
    /// `.codex` was made in it, failed, so a power loss could still take the file.
    #[error("the project's Codex config was made, but flushing its folder to disk failed")]
    FolderFlush(#[source] io::Error),
    /// Replacing the file that stood failed; it keeps its old contents.
    #[error("the project's Codex config could not be written")]
    Write(#[source] AtomicWriteError),
    /// Making the file where none stood failed; none stands.
    #[error("the project's Codex config could not be made")]
    Create(#[source] sidekicks_platforms::AtomicWriteError),
    /// The blocking task that read or wrote the file ended before it finished.
    #[error("the project's Codex config task ended before it finished")]
    Interrupted(#[source] JoinError),
}

impl CodexProjectFile {
    /// Reads `<project_root>/.codex/config.toml`, a link resolved to its target; an absent file
    /// reads as none. Fails when the file stands but cannot be read, and `DanglingLink` when it is
    /// a link to nothing.
    pub(super) async fn read(project_root: &Path) -> Result<Self, CodexProjectFileError> {
        let folder = project_root.join(CODEX_PROJECT_SETTINGS_FOLDER);
        tokio::task::spawn_blocking(move || read_project_file(folder))
            .await
            .map_err(CodexProjectFileError::Interrupted)?
    }

    /// Applies `edit` to `server_name`'s table and writes the file back only while it still
    /// hashes to what the read found; a file made since a read that found none counts as changed
    /// too. Fails as the parse, a value's form or the write fails.
    pub(super) async fn edit_server(
        self,
        server_name: &McpServerName,
        edit: CodexProjectServerEdit,
    ) -> Result<CodexProjectFileEdit, CodexProjectFileError> {
        let server_name = server_name.as_str().to_owned();
        tokio::task::spawn_blocking(move || self.write_edit(&server_name, edit))
            .await
            .map_err(CodexProjectFileError::Interrupted)?
    }

    // Edits and writes on the calling thread.
    fn write_edit(
        self,
        server_name: &str,
        edit: CodexProjectServerEdit,
    ) -> Result<CodexProjectFileEdit, CodexProjectFileError> {
        let Some(read) = self.read else {
            if edit == CodexProjectServerEdit::Remove {
                return Ok(CodexProjectFileEdit::Unchanged);
            }
            let rendered = edit_document("", server_name, edit)?;
            return create_project_file(&self.folder, &self.path, rendered.as_bytes());
        };
        let text =
            std::str::from_utf8(&read.bytes).map_err(|failure| CodexProjectFileError::NotToml {
                line: Some(line_at(&read.bytes, failure.valid_up_to())),
            })?;
        let rendered = edit_document(text, server_name, edit)?;
        if rendered == text {
            return Ok(CodexProjectFileEdit::Unchanged);
        }
        let is_written =
            write_and_flush_while(&self.path, rendered.as_bytes(), || {
                match fs::read(&self.path) {
                    Ok(bytes) => Ok(blake3::hash(&bytes) == read.hash),
                    Err(gone) if gone.kind() == io::ErrorKind::NotFound => Ok(false),
                    Err(failure) => Err(failure),
                }
            })
            .map_err(CodexProjectFileError::Write)?;
        Ok(if is_written {
            CodexProjectFileEdit::Written
        } else {
            CodexProjectFileEdit::FileChanged
        })
    }
}

// Reads the config in `folder` on the calling thread.
fn read_project_file(folder: PathBuf) -> Result<CodexProjectFile, CodexProjectFileError> {
    let named = folder.join(CODEX_CONFIG_FILE_NAME);
    let path = match real_path(&named) {
        Ok(path) => path,
        Err(absent) if absent.kind() == io::ErrorKind::NotFound => {
            return read_absent_project_file(folder, named);
        }
        Err(failure) => return Err(CodexProjectFileError::Read(failure)),
    };
    match fs::read(&path) {
        Ok(bytes) => Ok(CodexProjectFile {
            folder,
            path,
            read: Some(ReadContents {
                hash: blake3::hash(&bytes),
                bytes,
            }),
        }),
        // Removed between the resolve and the read.
        Err(absent) if absent.kind() == io::ErrorKind::NotFound => {
            read_absent_project_file(folder, named)
        }
        Err(failure) => Err(CodexProjectFileError::Read(failure)),
    }
}

// The config at `named` that no file stands behind: none where nothing stands there, so an add
// makes it, and refused where a link to nothing does, since every add would meet the link and
// answer that the file changed.
fn read_absent_project_file(
    folder: PathBuf,
    named: PathBuf,
) -> Result<CodexProjectFile, CodexProjectFileError> {
    // A file made since the resolve reads as none too: the add then answers that it changed.
    let is_dangling_link = match fs::symlink_metadata(&named) {
        Ok(metadata) => metadata.is_symlink(),
        Err(absent) if absent.kind() == io::ErrorKind::NotFound => false,
        Err(failure) => return Err(CodexProjectFileError::Read(failure)),
    };
    if is_dangling_link {
        return Err(CodexProjectFileError::DanglingLink);
    }
    Ok(CodexProjectFile {
        folder,
        path: named,
        read: None,
    })
}

// Makes the config where none stood, holding `contents`; a file made since the read is left as
// it is and answered as changed. A `.codex` folder made here is flushed into the project's folder
// too, so a power loss cannot take the new folder, and the file with it.
fn create_project_file(
    folder: &Path,
    path: &Path,
    contents: &[u8],
) -> Result<CodexProjectFileEdit, CodexProjectFileError> {
    let is_folder_made = match fs::create_dir(folder) {
        Ok(()) => true,
        Err(standing) if standing.kind() == io::ErrorKind::AlreadyExists => false,
        Err(failure) => return Err(CodexProjectFileError::Folder(failure)),
    };
    match create_file_atomically(
        path,
        contents,
        PROJECT_CONFIG_FILE_MODE,
        LeftoverSweep::Unswept,
    ) {
        Ok(()) => {}
        Err(standing)
            if standing.failure.kind() == io::ErrorKind::AlreadyExists
                && standing.removal_failure.is_none() =>
        {
            return Ok(CodexProjectFileEdit::FileChanged);
        }
        Err(failure) => return Err(CodexProjectFileError::Create(failure)),
    }
    flush_folder(folder).map_err(CodexProjectFileError::FolderFlush)?;
    if is_folder_made {
        let project_root = folder
            .parent()
            .expect("the `.codex` folder sits in the project's folder");
        flush_folder(project_root).map_err(CodexProjectFileError::FolderFlush)?;
    }
    Ok(CodexProjectFileEdit::Written)
}

// `text` with `edit` applied to `server_name`'s table, every byte outside that table as it was.
fn edit_document(
    text: &str,
    server_name: &str,
    edit: CodexProjectServerEdit,
) -> Result<String, CodexProjectFileError> {
    let mut document =
        text.parse::<DocumentMut>()
            .map_err(|failure| CodexProjectFileError::NotToml {
                line: failure
                    .span()
                    .map(|span| line_at(text.as_bytes(), span.start)),
            })?;
    match edit {
        CodexProjectServerEdit::Set(members) => {
            // A server added to an inline servers table takes the space before its closing brace
            // from the entry that ended it, so none is left before the comma between them.
            if let Some(inline) = document
                .get_mut(MCP_SERVERS_KEY)
                .and_then(Item::as_inline_table_mut)
                && !inline.contains_key(server_name)
                && let Some((_, last)) = inline.iter_mut().last()
            {
                last.decor_mut().set_suffix("");
            }
            // Implicit, so a servers' table the edit makes renders no header of its own.
            let servers = document
                .entry(MCP_SERVERS_KEY)
                .or_insert_with(|| {
                    let mut servers = Table::new();
                    servers.set_implicit(true);
                    Item::Table(servers)
                })
                .as_table_like_mut()
                .ok_or(CodexProjectFileError::ServersNotATable)?;
            if !servers.contains_key(server_name) {
                // One key, so a name holding a dot renders quoted rather than as a path.
                servers.insert(server_name, Item::Table(Table::new()));
            }
            let server = servers
                .get_mut(server_name)
                .and_then(Item::as_table_like_mut)
                .ok_or(CodexProjectFileError::ServerEntryNotATable)?;
            for (member, value) in members {
                let Some(value) = value else {
                    server.remove(&member);
                    continue;
                };
                let mut written = match value.serialize(ValueSerializer::new()) {
                    Ok(written) => written,
                    Err(failure) => {
                        return Err(CodexProjectFileError::UnwritableValue { member, failure });
                    }
                };
                match server.get_mut(&member) {
                    // The member's key and the comment after its value stay as written.
                    Some(Item::Value(standing)) => {
                        *written.decor_mut() = standing.decor().clone();
                        *standing = written;
                    }
                    _ => {
                        server.insert(&member, Item::Value(written));
                    }
                }
            }
        }
        CodexProjectServerEdit::Remove => {
            if let Some(servers) = document
                .get_mut(MCP_SERVERS_KEY)
                .and_then(Item::as_table_like_mut)
            {
                servers.remove(server_name);
            }
        }
    }
    Ok(document.to_string())
}

// The line, counted from 1, the byte at `offset` sits on.
fn line_at(bytes: &[u8], offset: usize) -> usize {
    memchr::memchr_iter(b'\n', &bytes[..offset.min(bytes.len())]).count() + 1
}

fn line_note(line: Option<usize>) -> String {
    line.map_or_else(String::new, |line| format!(" at line {line}"))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_platforms::{create_new_file, has_file_mode, make_folder_link};
    use toml_edit::DocumentMut;

    use super::{
        CodexProjectFile, CodexProjectFileEdit, CodexProjectFileError, CodexProjectServerEdit,
    };

    // A hand-written project config: a top comment, a table before the servers, a server with
    // comments after its values, and a table after them behind its own comment.
    const COMMENTED_CONFIG: &str = r#"# The project's own Codex settings.
model = "o4"

[profiles.fast]
model = "o4-mini" # the quick one

[mcp_servers.other]
command = "other-server" # started per session
args = ["--port", "4000"]  # spaced on purpose

# What the sandbox may reach.
[sandbox_workspace_write]
network_access = false
"#;

    // A project config whose servers sit in one inline table on the line that names them, a
    // comment after it, between a top comment and a table behind its own comment.
    const INLINE_SERVERS_CONFIG: &str = r#"# The project's own Codex settings.
model = "o4"
mcp_servers = { other = { command = "other-server", args = ["--port", "4000"] } } # per session

# What the sandbox may reach.
[sandbox_workspace_write]
network_access = false
"#;

    // How the line that names the servers in an inline table starts.
    const SERVERS_LINE_START: &str = "mcp_servers =";

    // `text`'s lines but the one naming the servers inline.
    fn lines_without_servers(text: &str) -> Vec<&str> {
        text.lines()
            .filter(|line| !line.starts_with(SERVERS_LINE_START))
            .collect()
    }

    fn server_name(name: &str) -> McpServerName {
        McpServerName::new(name.to_owned()).expect("a server name")
    }

    fn github_members() -> CodexProjectServerEdit {
        CodexProjectServerEdit::Set(vec![
            ("command".to_owned(), Some(json!("npx"))),
            (
                "args".to_owned(),
                Some(json!(["-y", "@modelcontextprotocol/server-github"])),
            ),
            ("env".to_owned(), Some(json!({ "LOG_LEVEL": "debug" }))),
        ])
    }

    async fn edit(root: &Path, name: &str, edit: CodexProjectServerEdit) -> CodexProjectFileEdit {
        CodexProjectFile::read(root)
            .await
            .expect("the config reads")
            .edit_server(&server_name(name), edit)
            .await
            .expect("the edit applies")
    }

    fn config_path(root: &Path) -> PathBuf {
        root.join(".codex").join("config.toml")
    }

    // `text` with the table headed `header`, its blank line before it included, cut out: the
    // table's lines run to the blank line that opens what follows it.
    fn without_table(text: &str, header: &str) -> String {
        let start = text
            .find(&format!("\n{header}\n"))
            .expect("the table is in the text");
        let end = start
            + 1
            + text[start + 1..]
                .find("\n\n")
                .expect("a blank line follows the table")
            + 1;
        format!("{}{}", &text[..start], &text[end..])
    }

    // An add and a remove keep every comment and byte outside the server's table, the file keeps
    // its permissions, and a name holding a dot stays one key. Killed by a whole-file rewrite
    // through a serde round trip, which drops the comments; by a write that takes a fixed mode or
    // the umask's; and by a name split at its dot.
    #[tokio::test]
    async fn an_edit_changes_only_the_servers_table_and_keeps_the_files_permissions() {
        let root = tempfile::tempdir().expect("a scratch project");
        let path = config_path(root.path());
        fs::create_dir(path.parent().expect("the config's folder")).expect("the folder is made");
        create_new_file(&path, 0o640)
            .expect("the config is made")
            .write_all(COMMENTED_CONFIG.as_bytes())
            .expect("the config is written");

        let added = edit(root.path(), "github", github_members()).await;

        assert_eq!(added, CodexProjectFileEdit::Written);
        let text = fs::read_to_string(&path).expect("the config reads back");
        assert_eq!(
            without_table(&text, "[mcp_servers.github]"),
            COMMENTED_CONFIG
        );
        let document = text.parse::<DocumentMut>().expect("the edit is TOML");
        let github = &document["mcp_servers"]["github"];
        assert_eq!(github["command"].as_str(), Some("npx"));
        assert_eq!(
            github["args"]
                .as_array()
                .expect("the arguments are an array")
                .iter()
                .map(|argument| argument.as_str())
                .collect::<Vec<_>>(),
            [Some("-y"), Some("@modelcontextprotocol/server-github")]
        );
        assert_eq!(github["env"]["LOG_LEVEL"].as_str(), Some("debug"));
        assert!(has_file_mode(&path, 0o640).expect("the config's mode reads"));

        let removed = edit(root.path(), "github", CodexProjectServerEdit::Remove).await;

        assert_eq!(removed, CodexProjectFileEdit::Written);
        assert_eq!(
            fs::read_to_string(&path).expect("the config reads back"),
            COMMENTED_CONFIG
        );

        let dotted = edit(
            root.path(),
            "a.b",
            CodexProjectServerEdit::Set(vec![("command".to_owned(), Some(json!("ab")))]),
        )
        .await;

        assert_eq!(dotted, CodexProjectFileEdit::Written);
        let text = fs::read_to_string(&path).expect("the config reads back");
        assert!(text.contains("\n[mcp_servers.\"a.b\"]\n"), "{text}");
        let document = text.parse::<DocumentMut>().expect("the edit is TOML");
        assert_eq!(
            document["mcp_servers"]["a.b"]["command"].as_str(),
            Some("ab")
        );
    }

    // An inline servers table takes the new server inside it, keeps the person's other entry, every
    // other line and the comment after it, and the file still reads as TOML the way Codex reads it.
    // Killed by the servers looked up as a table only, which refuses an inline one as no table, and
    // by the old last entry keeping its space before the closing brace, left before the comma.
    #[tokio::test]
    async fn an_inline_servers_table_takes_the_new_server_inside_it() {
        let root = tempfile::tempdir().expect("a scratch project");
        let path = config_path(root.path());
        fs::create_dir(path.parent().expect("the config's folder")).expect("the folder is made");
        fs::write(&path, INLINE_SERVERS_CONFIG).expect("the config is written");

        let added = edit(root.path(), "github", github_members()).await;

        assert_eq!(added, CodexProjectFileEdit::Written);
        let text = fs::read_to_string(&path).expect("the config reads back");
        assert_eq!(
            lines_without_servers(&text),
            lines_without_servers(INLINE_SERVERS_CONFIG)
        );
        let servers_lines: Vec<&str> = text
            .lines()
            .filter(|line| line.starts_with(SERVERS_LINE_START))
            .collect();
        assert_eq!(
            servers_lines.len(),
            1,
            "the servers stay on one line: {text}"
        );
        let other = r#"other = { command = "other-server", args = ["--port", "4000"] }"#;
        assert!(
            servers_lines[0].contains(&format!("{other}, github = {{")),
            "{text}"
        );
        assert!(servers_lines[0].ends_with(" # per session"), "{text}");
        let read: toml::Table = toml::from_str(&text).expect("Codex reads it");
        let servers = &read["mcp_servers"];
        assert_eq!(servers["other"]["command"].as_str(), Some("other-server"));
        let github = &servers["github"];
        assert_eq!(github["command"].as_str(), Some("npx"));
        assert_eq!(
            github["args"]
                .as_array()
                .expect("the arguments are an array")
                .iter()
                .map(toml::Value::as_str)
                .collect::<Vec<_>>(),
            [Some("-y"), Some("@modelcontextprotocol/server-github")]
        );
        assert_eq!(github["env"]["LOG_LEVEL"].as_str(), Some("debug"));
    }

    // A file another writer changed between the read and the edit keeps that writer's bytes, and
    // no temporary file is left beside it. Killed by a write that skips the hash check.
    #[tokio::test]
    async fn a_file_changed_since_the_read_is_left_as_the_other_writer_left_it() {
        let root = tempfile::tempdir().expect("a scratch project");
        let path = config_path(root.path());
        fs::create_dir(path.parent().expect("the config's folder")).expect("the folder is made");
        fs::write(&path, COMMENTED_CONFIG).expect("the config is written");
        let read = CodexProjectFile::read(root.path())
            .await
            .expect("the config reads");
        let theirs = "# Rewritten by another program.\nmodel = \"o3\"\n";
        fs::write(&path, theirs).expect("the other writer's bytes land");

        let outcome = read
            .edit_server(&server_name("github"), github_members())
            .await
            .expect("a changed file is no failure");

        assert_eq!(outcome, CodexProjectFileEdit::FileChanged);
        assert_eq!(
            fs::read_to_string(&path).expect("the config reads back"),
            theirs
        );
        let entries = fs::read_dir(path.parent().expect("the config's folder"))
            .expect("the folder lists")
            .map(|entry| entry.expect("an entry reads").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, ["config.toml"]);
    }

    // A config that is a link to nothing is refused as such. Killed by a read that takes the link
    // for no file, after which every add answers that the file changed.
    #[tokio::test]
    async fn a_config_linked_to_nothing_is_refused() {
        let root = tempfile::tempdir().expect("a scratch project");
        let path = config_path(root.path());
        let missing = root.path().join("missing");
        fs::create_dir(path.parent().expect("the config's folder")).expect("the folder is made");
        make_folder_link(&missing, &path).expect("the link is made");

        let read = CodexProjectFile::read(root.path()).await;

        assert!(matches!(read, Err(CodexProjectFileError::DanglingLink)));
    }

    // An add to a project with no config makes the folder and a file holding only the server's
    // table, and a remove there writes nothing and makes no folder. Killed by a remove that makes
    // a file, and by an add that fails on the missing folder.
    #[tokio::test]
    async fn an_absent_config_is_made_by_an_add_and_left_absent_by_a_remove() {
        let removed_from = tempfile::tempdir().expect("a scratch project");

        let removed = edit(
            removed_from.path(),
            "github",
            CodexProjectServerEdit::Remove,
        )
        .await;

        assert_eq!(removed, CodexProjectFileEdit::Unchanged);
        assert!(!removed_from.path().join(".codex").exists());

        let added_to = tempfile::tempdir().expect("a scratch project");

        let added = edit(added_to.path(), "github", github_members()).await;

        assert_eq!(added, CodexProjectFileEdit::Written);
        let text = fs::read_to_string(config_path(added_to.path())).expect("the config reads");
        assert!(text.starts_with("[mcp_servers.github]\n"), "{text}");
        let document = text.parse::<DocumentMut>().expect("the config is TOML");
        assert_eq!(
            document.iter().map(|(key, _item)| key).collect::<Vec<_>>(),
            ["mcp_servers"]
        );
        let servers = document["mcp_servers"]
            .as_table()
            .expect("the servers are a table");
        assert_eq!(
            servers.iter().map(|(key, _item)| key).collect::<Vec<_>>(),
            ["github"]
        );
        assert_eq!(
            document["mcp_servers"]["github"]["command"].as_str(),
            Some("npx")
        );
    }
}
