//! Codex's rule files read without running them: each file is parsed with the parser of Codex's own
//! loader, and each top-level call of Codex's builtins (`prefix_rule`, `network_rule`,
//! `host_executable`) whose arguments are written out is held to the checks Codex makes when it
//! loads the file, so a file Codex would refuse is refused here too. A file holding anything else
//! (a variable, a loop, a function, a computed value) only running it would show, so it is read
//! as a whole as a file the daemon cannot read, never as part of its rules.

use std::collections::HashMap;

use sidekicks_contracts::approval::{RememberedRuleSense, RememberedScopeKind};
use sidekicks_platforms::PathRules;
use starlark_syntax::syntax::ast::{
    ArgumentP, AstArgument, AstExpr, AstLiteral, AstStmt, ExprP, StmtP,
};
use starlark_syntax::syntax::top_level_stmts::top_level_stmts;
use starlark_syntax::syntax::{AstModule, Dialect};

use super::normalize_network_rule_host;
use crate::provider::port::permission_ask::{ProviderAskActionKind, ProviderAskRule};

// The names Starlark's standard environment binds, which Codex's loader keeps beside its builtins.
const STARLARK_STANDARD_NAMES: [&str; 31] = [
    "False",
    "None",
    "True",
    "abs",
    "all",
    "any",
    "bool",
    "bytes",
    "chr",
    "dict",
    "dir",
    "enumerate",
    "fail",
    "float",
    "getattr",
    "hasattr",
    "hash",
    "int",
    "len",
    "list",
    "max",
    "min",
    "ord",
    "range",
    "repr",
    "reversed",
    "sorted",
    "str",
    "tuple",
    "type",
    "zip",
];

// Each builtin's parameters, in the order a positional argument fills them.
const PREFIX_RULE_PARAMETERS: [&str; 5] =
    ["pattern", "decision", "match", "not_match", "justification"];
const NETWORK_RULE_PARAMETERS: [&str; 4] = ["host", "protocol", "decision", "justification"];
const HOST_EXECUTABLE_PARAMETERS: [&str; 2] = ["name", "paths"];

// The protocols a network rule may name.
const NETWORK_RULE_PROTOCOLS: [&str; 6] = [
    "http",
    "https",
    "https_connect",
    "http-connect",
    "socks5_tcp",
    "socks5_udp",
];

// The endings Codex strips from a program's name on Windows before it looks the name up.
const WINDOWS_PROGRAM_SUFFIXES: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];

/// What one rule file holds as the daemon reads it.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RuleFileReading {
    /// Every allow and block the file makes; a rule Codex asks on (`prompt`) is neither.
    Read(Vec<ProviderAskRule>),
    /// The file makes rules only running it would show, for the reason given.
    Unread(String),
}

/// Reads rule files in the order Codex loads them, carrying what one file declares for the next:
/// the program paths a `host_executable` call names, which the checks of a rule's examples read.
pub(super) struct RuleFileReader {
    path_rules: PathRules,
    host_executables: HashMap<String, Vec<String>>,
}

// Why a call cannot be read: Codex refuses it, or only running the file would show it.
enum CallFailure {
    Refused(String),
    Computed(&'static str),
}

impl From<&str> for CallFailure {
    fn from(reason: &str) -> Self {
        Self::Refused(reason.to_owned())
    }
}

impl From<String> for CallFailure {
    fn from(reason: String) -> Self {
        Self::Refused(reason)
    }
}

// An argument's expression, as far as it reads without running the file.
enum ArgumentValue<'a> {
    Text(&'a str),
    List(&'a [AstExpr]),
    // A name the file does not bind holds no text or list, and one it binds is computed.
    Name,
    // A literal of a type no builtin parameter takes: a number, a tuple, a dictionary.
    OtherLiteral,
    Computed,
}

// One `prefix_rule`'s rules and the examples Codex checks them against once the file is read.
struct PrefixRuleExamples {
    patterns: Vec<PrefixPattern>,
    matches: Vec<Vec<String>>,
    not_matches: Vec<Vec<String>>,
}

// One rule's pattern: its program, then each later word's alternatives.
struct PrefixPattern {
    program: String,
    rest: Vec<Vec<String>>,
}

// Whether an example matches a rule, where it can be told without Codex's working folder.
enum ExampleMatch {
    Matched,
    Unmatched,
    Unknown,
}

impl RuleFileReader {
    /// A reader for rule files Codex loads in a place that spells paths by `path_rules`.
    pub(super) fn new(path_rules: PathRules) -> Self {
        Self {
            path_rules,
            host_executables: HashMap::new(),
        }
    }

    /// Reads one file named `file_name` holding `text`. Fails with Codex's reason where Codex
    /// refuses the file, which then drops every rule of the person and the project.
    pub(super) fn read(
        &mut self,
        file_name: &str,
        text: String,
    ) -> Result<RuleFileReading, String> {
        let dialect = Dialect {
            enable_f_strings: true,
            ..Dialect::Extended
        };
        let module = AstModule::parse(file_name, text, &dialect)
            .map_err(|failure| failure.into_anyhow().to_string())?;
        let statements = top_level_stmts(module.statement());
        // A file that binds no name of its own leaves every name to Starlark and Codex, so a name
        // neither knows is one Codex refuses.
        let is_binding_names = statements
            .iter()
            .any(|statement| is_binding_statement(statement));
        let mut unread_statement = None;
        for statement in &statements {
            if let Some(reason) = unread_statement_reason(statement, is_binding_names)? {
                unread_statement.get_or_insert(reason);
            }
        }
        let mut rules: Vec<ProviderAskRule> = Vec::new();
        let mut examples = Vec::new();
        let mut computed = None;
        for statement in statements {
            let StmtP::Expression(expression) = &**statement else {
                continue;
            };
            let ExprP::Call(callee, call) = &expression.node else {
                continue;
            };
            let ExprP::Identifier(name) = &callee.node else {
                continue;
            };
            let outcome = match name.ident.as_str() {
                "prefix_rule" => {
                    read_prefix_rule(&call.args, is_binding_names).map(|(read, call_examples)| {
                        examples.push(call_examples);
                        read
                    })
                }
                "network_rule" => read_network_rule(&call.args, is_binding_names),
                "host_executable" => self
                    .read_host_executable(&call.args, is_binding_names)
                    .map(|()| Vec::new()),
                _ => continue,
            };
            match outcome {
                Ok(read) => {
                    for rule in read {
                        if !rules.contains(&rule) {
                            rules.push(rule);
                        }
                    }
                }
                Err(CallFailure::Refused(reason)) => return Err(reason),
                Err(CallFailure::Computed(reason)) => {
                    computed.get_or_insert(reason);
                }
            }
        }
        for call_examples in &examples {
            match self.check_examples(call_examples) {
                Ok(()) => {}
                Err(CallFailure::Refused(reason)) => return Err(reason),
                Err(CallFailure::Computed(reason)) => {
                    computed.get_or_insert(reason);
                }
            }
        }
        Ok(match (unread_statement, computed) {
            (Some(reason), _) => RuleFileReading::Unread(reason),
            (None, Some(reason)) => RuleFileReading::Unread(reason.to_owned()),
            (None, None) => RuleFileReading::Read(rules),
        })
    }

    // A `host_executable` as Codex's builtin reads it: a bare program name and the absolute paths
    // it may run from, each ending in that name; a later call for the name replaces an earlier.
    fn read_host_executable(
        &mut self,
        arguments: &[AstArgument],
        is_binding_names: bool,
    ) -> Result<(), CallFailure> {
        let bound = bind_arguments(arguments, &HOST_EXECUTABLE_PARAMETERS, "host_executable")?;
        let name = read_required_text(&bound, "name", is_binding_names)?;
        let paths_value = bound
            .get("paths")
            .ok_or("a host executable names no paths")?;
        let paths = read_text_list(paths_value, is_binding_names)?;
        let is_bare = !name.is_empty()
            && name != "."
            && name != ".."
            && !name
                .chars()
                .any(|character| self.path_rules.is_separator(character))
            && !(self.path_rules.has_drive_letters() && name.contains(':'));
        if !is_bare {
            return Err("a host executable's name is not a bare program name".into());
        }
        let name_key = self.program_lookup_key(name);
        let mut kept: Vec<String> = Vec::new();
        for path in paths {
            if !self.path_rules.is_absolute(path) {
                return Err("a host executable's path is not absolute".into());
            }
            let Some((normalized, base_name)) = self.normalize_path(path) else {
                return Err("a host executable's path names no program".into());
            };
            if self.program_lookup_key(&base_name) != name_key {
                return Err("a host executable's path does not end in its name".into());
            }
            if !kept.contains(&normalized) {
                kept.push(normalized);
            }
        }
        self.host_executables.insert(name_key, kept);
        Ok(())
    }

    // Codex's check of a rule's examples: none it must not match matches, then each it must match
    // does, a program named by its path matching a rule on the program's name.
    fn check_examples(&self, examples: &PrefixRuleExamples) -> Result<(), CallFailure> {
        for example in &examples.not_matches {
            match self.match_example(&examples.patterns, example) {
                ExampleMatch::Matched => {
                    return Err(
                        format!("the rule matches its example `{}`", example.join(" ")).into(),
                    );
                }
                ExampleMatch::Unmatched => {}
                ExampleMatch::Unknown => return Err(CallFailure::Computed(UNKNOWN_EXAMPLE)),
            }
        }
        for example in &examples.matches {
            match self.match_example(&examples.patterns, example) {
                ExampleMatch::Matched => {}
                ExampleMatch::Unmatched => {
                    return Err(format!(
                        "the rule does not match its example `{}`",
                        example.join(" ")
                    )
                    .into());
                }
                ExampleMatch::Unknown => return Err(CallFailure::Computed(UNKNOWN_EXAMPLE)),
            }
        }
        Ok(())
    }

    fn match_example(&self, patterns: &[PrefixPattern], example: &[String]) -> ExampleMatch {
        let Some((program, arguments)) = example.split_first() else {
            return ExampleMatch::Unmatched;
        };
        if patterns
            .iter()
            .any(|pattern| pattern.program == *program && pattern.matches_rest(arguments))
        {
            return ExampleMatch::Matched;
        }
        // Only a program named by a path reaches the rules on its name.
        if !program
            .chars()
            .any(|character| self.path_rules.is_separator(character))
        {
            return ExampleMatch::Unmatched;
        }
        let Some((normalized, base_name)) = self.normalize_path(program) else {
            return ExampleMatch::Unmatched;
        };
        let key = self.program_lookup_key(&base_name);
        let candidates: Vec<&PrefixPattern> = patterns
            .iter()
            .filter(|pattern| pattern.program == key)
            .collect();
        if candidates.is_empty() {
            return ExampleMatch::Unmatched;
        }
        if let Some(paths) = self.host_executables.get(&key) {
            // A relative path resolves against Codex's working folder, which a file does not name.
            if !self.path_rules.is_absolute(program) {
                return ExampleMatch::Unknown;
            }
            if !paths.contains(&normalized) {
                return ExampleMatch::Unmatched;
            }
        }
        if candidates
            .iter()
            .any(|pattern| pattern.matches_rest(arguments))
        {
            ExampleMatch::Matched
        } else {
            ExampleMatch::Unmatched
        }
    }

    // A path with `.` and `..` resolved by its words, as Codex makes it absolute, and its last
    // name; `None` where no name is left.
    fn normalize_path(&self, path: &str) -> Option<(String, String)> {
        let separator = self.path_rules.separator();
        let mut words: Vec<&str> = Vec::new();
        let mut root_len = 0;
        for (index, word) in path
            .split(|character| self.path_rules.is_separator(character))
            .enumerate()
        {
            match word {
                "" if index == 0 => root_len = 1,
                "" | "." => {}
                ".." => {
                    words.pop();
                }
                word => words.push(word),
            }
        }
        let base_name = (*words.last()?).to_owned();
        let mut normalized = String::with_capacity(path.len());
        if root_len == 1 {
            normalized.push(separator);
        }
        normalized.push_str(&words.join(&separator.to_string()));
        Some((normalized, base_name))
    }

    // A program's name as Codex looks it up: on Windows in lower case without its ending.
    fn program_lookup_key(&self, name: &str) -> String {
        if self.path_rules != PathRules::Windows {
            return name.to_owned();
        }
        let lowered = name.to_ascii_lowercase();
        WINDOWS_PROGRAM_SUFFIXES
            .iter()
            .find_map(|suffix| lowered.strip_suffix(suffix))
            .map_or_else(|| lowered.clone(), ToOwned::to_owned)
    }
}

// Why an example cannot be checked without running Codex.
const UNKNOWN_EXAMPLE: &str = "an example names a program by a path relative to Codex's folder";

impl PrefixPattern {
    fn matches_rest(&self, arguments: &[String]) -> bool {
        arguments.len() >= self.rest.len()
            && self
                .rest
                .iter()
                .zip(arguments)
                .all(|(alternatives, word)| alternatives.contains(word))
    }
}

// Whether a top-level statement may bind a name of the file's own.
fn is_binding_statement(statement: &AstStmt) -> bool {
    match &**statement {
        StmtP::Assign(_)
        | StmtP::AssignModify(..)
        | StmtP::For(_)
        | StmtP::Def(_)
        | StmtP::If(..)
        | StmtP::IfElse(..)
        | StmtP::Statements(_) => true,
        StmtP::Pass
        | StmtP::Load(_)
        | StmtP::Expression(_)
        | StmtP::Break
        | StmtP::Continue
        | StmtP::Return(_) => false,
    }
}

// Why a top-level statement is one only running the file reads, `None` for one a reader reads (a
// builtin's call, a bare literal or `pass`); fails where Codex refuses it: a `load`, or a call to a
// name Codex does not know in a file that binds none.
fn unread_statement_reason(
    statement: &AstStmt,
    is_binding_names: bool,
) -> Result<Option<String>, String> {
    let reason = match &**statement {
        StmtP::Pass => return Ok(None),
        StmtP::Load(_) => return Err("Codex loads no other file".to_owned()),
        StmtP::Expression(expression) => {
            if let ExprP::Literal(_) = &expression.node {
                return Ok(None);
            }
            let ExprP::Call(callee, _) = &expression.node else {
                return Ok(Some("a computed value".to_owned()));
            };
            let ExprP::Identifier(name) = &callee.node else {
                return Ok(Some("a computed call".to_owned()));
            };
            let name = name.ident.as_str();
            if matches!(name, "prefix_rule" | "network_rule" | "host_executable") {
                return Ok(None);
            }
            if !is_binding_names && !STARLARK_STANDARD_NAMES.contains(&name) {
                return Err(format!("Codex knows no `{name}`"));
            }
            format!("a call to `{name}`")
        }
        StmtP::Assign(_) | StmtP::AssignModify(..) => "a variable".to_owned(),
        StmtP::For(_) => "a loop".to_owned(),
        StmtP::Def(_) => "a function".to_owned(),
        StmtP::If(..) | StmtP::IfElse(..) => "a condition".to_owned(),
        StmtP::Break | StmtP::Continue | StmtP::Return(_) | StmtP::Statements(_) => {
            "a statement only running the file reads".to_owned()
        }
    };
    Ok(Some(reason))
}

// The arguments of a call by its parameters' names, positional ones in the parameters' order.
// Refuses an argument past the last parameter, one no parameter names and a parameter given twice;
// `*` and `**` arguments are computed.
fn bind_arguments<'call>(
    arguments: &'call [AstArgument],
    parameters: &[&'static str],
    builtin: &str,
) -> Result<HashMap<&'static str, &'call AstExpr>, CallFailure> {
    let mut bound = HashMap::with_capacity(arguments.len());
    for (index, argument) in arguments.iter().enumerate() {
        let (parameter, value) = match &argument.node {
            ArgumentP::Positional(value) => {
                let parameter = parameters.get(index).ok_or_else(|| {
                    format!("`{builtin}` takes at most {} arguments", parameters.len())
                })?;
                (*parameter, value)
            }
            ArgumentP::Named(name, value) => {
                let parameter = parameters
                    .iter()
                    .find(|parameter| **parameter == name.node)
                    .ok_or_else(|| format!("`{builtin}` has no argument `{}`", name.node))?;
                (*parameter, value)
            }
            ArgumentP::Args(_) | ArgumentP::KwArgs(_) => {
                return Err(CallFailure::Computed("a rule built from spread arguments"));
            }
        };
        if bound.insert(parameter, value).is_some() {
            return Err(format!("`{builtin}` is given `{parameter}` twice").into());
        }
    }
    Ok(bound)
}

fn read_argument_value(expression: &AstExpr) -> ArgumentValue<'_> {
    if let ExprP::Literal(AstLiteral::String(text)) = &expression.node {
        return ArgumentValue::Text(&text.node);
    }
    if let ExprP::Literal(_) | ExprP::Tuple(_) | ExprP::Dict(_) | ExprP::Lambda(_) =
        &expression.node
    {
        return ArgumentValue::OtherLiteral;
    }
    if let ExprP::List(items) = &expression.node {
        return ArgumentValue::List(items);
    }
    if let ExprP::Identifier(_) = &expression.node {
        return ArgumentValue::Name;
    }
    ArgumentValue::Computed
}

// A text argument. A name holds text only where the file binds it, which only running it shows.
fn read_text(expression: &AstExpr, is_binding_names: bool) -> Result<&str, CallFailure> {
    match read_argument_value(expression) {
        ArgumentValue::Text(text) => Ok(text),
        ArgumentValue::Name if is_binding_names => Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
        ArgumentValue::List(_) | ArgumentValue::Name | ArgumentValue::OtherLiteral => {
            Err("an argument that takes text is given something else".into())
        }
        ArgumentValue::Computed => Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
    }
}

// A list argument's items.
fn read_list(expression: &AstExpr, is_binding_names: bool) -> Result<&[AstExpr], CallFailure> {
    match read_argument_value(expression) {
        ArgumentValue::List(items) => Ok(items),
        ArgumentValue::Name if is_binding_names => Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
        ArgumentValue::Text(_) | ArgumentValue::Name | ArgumentValue::OtherLiteral => {
            Err("an argument that takes a list is given something else".into())
        }
        ArgumentValue::Computed => Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
    }
}

// Why a rule is unread when one of its arguments is computed.
const COMPUTED_ARGUMENT: &str = "a rule built from a computed value";

fn read_text_list(expression: &AstExpr, is_binding_names: bool) -> Result<Vec<&str>, CallFailure> {
    read_list(expression, is_binding_names)?
        .iter()
        .map(|item| read_text(item, is_binding_names))
        .collect()
}

fn read_optional_text<'call>(
    bound: &HashMap<&'static str, &'call AstExpr>,
    parameter: &str,
    is_binding_names: bool,
) -> Result<Option<&'call str>, CallFailure> {
    bound
        .get(parameter)
        .map(|value| read_text(value, is_binding_names))
        .transpose()
}

fn read_required_text<'call>(
    bound: &HashMap<&'static str, &'call AstExpr>,
    parameter: &str,
    is_binding_names: bool,
) -> Result<&'call str, CallFailure> {
    read_optional_text(bound, parameter, is_binding_names)?
        .ok_or_else(|| format!("a rule names no `{parameter}`").into())
}

fn read_justification(
    bound: &HashMap<&'static str, &AstExpr>,
    is_binding_names: bool,
) -> Result<(), CallFailure> {
    match read_optional_text(bound, "justification", is_binding_names)? {
        Some(justification) if justification.trim().is_empty() => {
            Err("a rule's justification is blank".into())
        }
        Some(_) | None => Ok(()),
    }
}

// A pattern's words, each the alternatives a word may take.
fn read_pattern(
    expression: &AstExpr,
    is_binding_names: bool,
) -> Result<Vec<Vec<String>>, CallFailure> {
    let mut pattern = Vec::new();
    for token in read_list(expression, is_binding_names)? {
        let alternatives = match read_argument_value(token) {
            ArgumentValue::Text(word) => vec![word.to_owned()],
            ArgumentValue::List(_) => read_text_list(token, is_binding_names)?
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ArgumentValue::Name if is_binding_names => {
                return Err(CallFailure::Computed(COMPUTED_ARGUMENT));
            }
            ArgumentValue::Name | ArgumentValue::OtherLiteral => {
                return Err("a pattern's word is neither text nor a list of text".into());
            }
            ArgumentValue::Computed => return Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
        };
        if alternatives.is_empty() {
            return Err("a pattern's alternatives are empty".into());
        }
        pattern.push(alternatives);
    }
    if pattern.is_empty() {
        return Err("a pattern is empty".into());
    }
    Ok(pattern)
}

// A rule's examples: each a command line split as a shell splits it, or a list of its words.
fn read_examples(
    bound: &HashMap<&'static str, &AstExpr>,
    parameter: &str,
    is_binding_names: bool,
) -> Result<Vec<Vec<String>>, CallFailure> {
    let Some(value) = bound.get(parameter) else {
        return Ok(Vec::new());
    };
    let mut examples = Vec::new();
    for example in read_list(value, is_binding_names)? {
        let words: Vec<String> = match read_argument_value(example) {
            ArgumentValue::Text(line) => {
                shlex::split(line).ok_or("an example is not a shell command line")?
            }
            ArgumentValue::List(_) => read_text_list(example, is_binding_names)?
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ArgumentValue::Name if is_binding_names => {
                return Err(CallFailure::Computed(COMPUTED_ARGUMENT));
            }
            ArgumentValue::Name | ArgumentValue::OtherLiteral => {
                return Err("an example is neither text nor a list of text".into());
            }
            ArgumentValue::Computed => return Err(CallFailure::Computed(COMPUTED_ARGUMENT)),
        };
        if words.is_empty() {
            return Err("an example is empty".into());
        }
        examples.push(words);
    }
    Ok(examples)
}

// A `prefix_rule` as Codex's builtin reads it: a non-empty pattern of words or lists of alternative
// words, each alternative of the first making a rule of its own, a decision of `allow` (the
// default), `prompt` or `forbidden`, examples it must and must not match, and a justification that
// is not blank.
fn read_prefix_rule(
    arguments: &[AstArgument],
    is_binding_names: bool,
) -> Result<(Vec<ProviderAskRule>, PrefixRuleExamples), CallFailure> {
    let bound = bind_arguments(arguments, &PREFIX_RULE_PARAMETERS, "prefix_rule")?;
    let sense = match read_optional_text(&bound, "decision", is_binding_names)? {
        None | Some("allow") => Some(RememberedRuleSense::Allow),
        Some("forbidden") => Some(RememberedRuleSense::Block),
        Some("prompt") => None,
        Some(other) => return Err(format!("`{other}` is not a decision Codex reads").into()),
    };
    read_justification(&bound, is_binding_names)?;
    let pattern_value = bound
        .get("pattern")
        .ok_or("a prefix rule names no pattern")?;
    let pattern = read_pattern(pattern_value, is_binding_names)?;
    let matches = read_examples(&bound, "match", is_binding_names)?;
    let not_matches = read_examples(&bound, "not_match", is_binding_names)?;
    let (program_alternatives, rest) = pattern.split_first().expect("a read pattern holds a word");
    let examples = PrefixRuleExamples {
        patterns: program_alternatives
            .iter()
            .map(|program| PrefixPattern {
                program: program.clone(),
                rest: rest.to_vec(),
            })
            .collect(),
        matches,
        not_matches,
    };
    let Some(sense) = sense else {
        return Ok((Vec::new(), examples));
    };
    let mut subjects = vec![String::new()];
    for alternatives in &pattern {
        subjects = subjects
            .iter()
            .flat_map(|prefix| {
                alternatives.iter().map(move |word| {
                    if prefix.is_empty() {
                        word.clone()
                    } else {
                        format!("{prefix} {word}")
                    }
                })
            })
            .collect();
    }
    let rules = subjects
        .into_iter()
        .map(|subject| ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense,
            action: ProviderAskActionKind::Command,
            subject,
        })
        .collect();
    Ok((rules, examples))
}

// A `network_rule` as Codex's builtin reads it: a host Codex keeps, a protocol it knows, a decision
// of `allow`, `prompt`, or `deny` or `forbidden`, and a justification that is not blank.
fn read_network_rule(
    arguments: &[AstArgument],
    is_binding_names: bool,
) -> Result<Vec<ProviderAskRule>, CallFailure> {
    let bound = bind_arguments(arguments, &NETWORK_RULE_PARAMETERS, "network_rule")?;
    let host = read_required_text(&bound, "host", is_binding_names)?;
    let protocol = read_required_text(&bound, "protocol", is_binding_names)?;
    let decision = read_required_text(&bound, "decision", is_binding_names)?;
    read_justification(&bound, is_binding_names)?;
    if !NETWORK_RULE_PROTOCOLS.contains(&protocol) {
        return Err(format!("`{protocol}` is not a protocol Codex reads").into());
    }
    let sense = match decision {
        "allow" => Some(RememberedRuleSense::Allow),
        "deny" | "forbidden" => Some(RememberedRuleSense::Block),
        "prompt" => None,
        other => return Err(format!("`{other}` is not a decision Codex reads").into()),
    };
    let host = normalize_network_rule_host(host)?;
    Ok(sense
        .map(|sense| ProviderAskRule {
            kind: RememberedScopeKind::Project,
            sense,
            action: ProviderAskActionKind::Network,
            subject: host,
        })
        .into_iter()
        .collect())
}
