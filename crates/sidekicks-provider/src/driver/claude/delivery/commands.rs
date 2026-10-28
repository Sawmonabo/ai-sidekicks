//! The shell and Monitor tasks Claude Code reports, as rows of the session's running commands: a
//! task's start, its move to the background, its end and the whole set of background tasks it
//! re-sends. A helper's, a workflow's and a tool server's task are no command. Each command's
//! line is read off the Bash or Monitor call that started it, which pairs its row with the wrapper
//! that runs it, and the commands' channel opens before each process starts so the wrapper reaches
//! the daemon. A process apart from the session's own, such as a staged review's, has a channel of
//! its own whose commands are rows under that process's one run.

mod apart_run;

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_platforms::{FolderArrivalWatch, RUNS_COMMAND_WRAPPER};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::task::JoinHandle;

pub(crate) use self::apart_run::ClaudeApartCommand;
use self::apart_run::ClaudeApartRunCommands;
use crate::command::askpass::command_prompt_environment;
use crate::command::channel::records::follow_channel_records;
use crate::command::channel::{CommandChannel, command_channel_root};
use crate::command::running_set::RunningCommandSets;
use crate::command::waiting_checks::InputWaitReader;
use crate::command::wrapper::COMMAND_PROVIDER_VARIABLE;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::command_shape::{CLAUDE_SHELL_PREFIX_COMMAND, bash_line_text};
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::port::running_command_publisher::{
    CommandStart, ProviderCommandEnd, ReseedScope, RunningCommandPublisher,
};

/// The `task_type` of a helper's task.
pub(crate) const CLAUDE_HELPER_TASK_TYPE: &str = "local_agent";

/// The `task_type` of a tool server's call Claude Code runs in the background.
pub(crate) const CLAUDE_TOOL_SERVER_TASK_TYPE: &str = "mcp_task";

/// The `task_type` of a workflow's task.
const CLAUDE_WORKFLOW_TASK_TYPE: &str = "local_workflow";

/// The tools whose calls start a shell or Monitor task, each naming its line in `command`.
const CLAUDE_COMMAND_TOOLS: [&str; 2] = ["Bash", "Monitor"];

/// How many started calls' lines are kept for the task each starts; a call's task follows it at
/// once, so only the newest few are ever looked up.
const CLAUDE_COMMAND_CALLS_KEPT: usize = 64;

/// The members of a `task_*` or `background_tasks_changed` frame the rows read.
#[derive(Deserialize)]
pub(crate) struct ClaudeTaskFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    task_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    parent_task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    description: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    patch: Option<ClaudeTaskPatch>,
    #[serde(default, deserialize_with = "read_lenient")]
    status: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    summary: Option<String>,
    /// The files a tool server's finished task returned by reference, relayed unread.
    #[serde(default)]
    resource_links: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    tasks: Option<LenientList<ClaudeListedTask>>,
}

#[derive(Deserialize)]
struct ClaudeTaskPatch {
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
}

#[derive(Deserialize)]
struct ClaudeListedTask {
    #[serde(default, deserialize_with = "read_lenient")]
    task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    task_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    description: Option<String>,
}

// The `command` of a Bash or Monitor call's input.
#[derive(Deserialize)]
struct ClaudeCommandCallInput {
    #[serde(default, deserialize_with = "read_lenient")]
    command: Option<String>,
}

lenient_object!(
    ClaudeTaskFrame,
    ClaudeTaskPatch,
    ClaudeListedTask,
    ClaudeCommandCallInput
);

impl ClaudeTaskFrame {
    /// Reads one frame's text; `None` when it is no JSON object.
    pub(crate) fn read(text: &str) -> Option<Self> {
        <Self as Lenient>::read(&mut serde_json::Deserializer::from_str(text))
            .ok()
            .flatten()
    }

    /// The task, where the frame names one.
    pub(crate) fn task_id(&self) -> Option<&str> {
        non_empty(self.task_id.as_deref())
    }

    /// The task's kind as Claude Code names it, where the frame names one.
    pub(crate) fn task_type(&self) -> Option<&str> {
        non_empty(self.task_type.as_deref())
    }

    /// The tool call that started the task, where the frame names it.
    pub(crate) fn tool_use_id(&self) -> Option<&str> {
        non_empty(self.tool_use_id.as_deref())
    }

    /// The helper's task that started this one, where a helper did.
    pub(crate) fn parent_task_id(&self) -> Option<&str> {
        non_empty(self.parent_task_id.as_deref())
    }

    /// How a finished task ended: `completed`, `failed` or `stopped`.
    pub(crate) fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    /// Claude Code's summary of a finished task.
    pub(crate) fn summary(&self) -> Option<&str> {
        non_empty(self.summary.as_deref())
    }

    /// The files a tool server's finished task returned by reference, as sent.
    pub(crate) fn resource_links(&self) -> Option<&RawValue> {
        self.resource_links.as_deref()
    }
}

/// What one task frame changes in the session's running commands.
pub(crate) enum ClaudeCommandFact {
    /// A command started.
    Started(CommandStart),
    /// A command moved to the background.
    MovedToBackground(CommandStart),
    /// A command ended.
    Ended {
        /// The session.
        session_id: SessionId,
        /// The command.
        command_id: CommandId,
        /// How Claude Code reported it ended.
        end: ProviderCommandEnd,
    },
    /// Every command running in the background now.
    Listed {
        /// The session.
        session_id: SessionId,
        /// The commands.
        listed: Vec<CommandStart>,
    },
}

impl ClaudeCommandFact {
    /// Hands the fact to the session's running commands.
    pub(crate) fn publish(self, publisher: &dyn RunningCommandPublisher) {
        match self {
            Self::Started(start) => publisher.command_started(start),
            Self::MovedToBackground(start) => publisher.command_moved_to_background(start),
            Self::Ended {
                session_id,
                command_id,
                end,
            } => publisher.command_ended(session_id, command_id, end),
            Self::Listed { session_id, listed } => {
                publisher.commands_listed(session_id, ReseedScope::BackgroundCommands, listed);
            }
        }
    }
}

/// A running command a process's tasks hold: its row's start, and the tool call that started it
/// where Claude Code named it.
#[derive(Clone)]
pub(crate) struct ClaudeHeldCommand {
    /// The tool call that started it.
    pub(crate) tool_use_id: Option<String>,
    /// Its row's start.
    pub(crate) start: CommandStart,
}

// A command task the session's running commands hold, with the call that started it.
struct ClaudeCommandTask {
    tool_use_id: Option<String>,
    start: CommandStart,
}

/// One session's command tasks: the lines of the Bash and Monitor calls its agents started, each
/// command task by its id while it runs, and how many tasks running no command the latest
/// background set listed.
#[derive(Default)]
pub(crate) struct ClaudeCommandTasks {
    calls: VecDeque<(String, String)>,
    tasks: HashMap<String, ClaudeCommandTask>,
    listed_other_tasks: usize,
}

impl ClaudeCommandTasks {
    /// Keeps the line of each Bash or Monitor call `frame` starts, the lead's or a helper's.
    pub(crate) fn observe_calls(&mut self, frame: &ClaudeMessageFrame) {
        for (call_id, tool_name, input) in frame.tool_uses() {
            if !CLAUDE_COMMAND_TOOLS.contains(&tool_name) {
                continue;
            }
            let command = input
                .and_then(|input| {
                    <ClaudeCommandCallInput as Lenient>::read(
                        &mut serde_json::Deserializer::from_str(input.get()),
                    )
                    .ok()
                    .flatten()
                })
                .and_then(|input| input.command)
                .filter(|command| !command.is_empty());
            if let Some(command) = command {
                if self.calls.len() == CLAUDE_COMMAND_CALLS_KEPT {
                    self.calls.pop_front();
                }
                self.calls.push_back((call_id.to_owned(), command));
            }
        }
    }

    /// The running command `task_id`: its row's start, and the tool call that started it where
    /// Claude Code named it.
    pub(crate) fn held_command(&self, task_id: &str) -> Option<ClaudeHeldCommand> {
        let task = self.tasks.get(task_id)?;
        Some(ClaudeHeldCommand {
            tool_use_id: task.tool_use_id.clone(),
            start: task.start.clone(),
        })
    }

    /// What `frame`, of `kind`, changes in `session_id`'s running commands; `run_id` is the run a
    /// task it starts belongs to. A task of a helper, a workflow or a tool server, or one of no
    /// kind, is no command; a later start of a task the background set already listed gives that
    /// task the line of the call that started it, and its start again.
    pub(crate) fn read_frame(
        &mut self,
        kind: &ClaudeWireFrameKind,
        frame: &ClaudeTaskFrame,
        session_id: SessionId,
        run_id: Option<RunId>,
    ) -> Option<ClaudeCommandFact> {
        match kind {
            ClaudeWireFrameKind::SystemTaskStarted => self
                .start(frame, session_id, run_id)
                .map(ClaudeCommandFact::Started),
            ClaudeWireFrameKind::SystemTaskUpdated => {
                let patch = frame.patch.as_ref()?;
                if patch.is_backgrounded != Some(true) {
                    return None;
                }
                let task = self.tasks.get_mut(frame.task_id()?)?;
                task.start.is_backgrounded = true;
                task.start.can_move_to_background = false;
                Some(ClaudeCommandFact::MovedToBackground(task.start.clone()))
            }
            ClaudeWireFrameKind::SystemTaskNotification => {
                let task = self.tasks.remove(frame.task_id()?)?;
                // Claude Code stops a task itself at its time limit, at the agent's `TaskStop`
                // and when its process restarted; each ends the command failed, with the summary.
                let is_stopped_by_provider = frame.status() == Some("stopped");
                Some(ClaudeCommandFact::Ended {
                    session_id,
                    command_id: task.start.command_id,
                    end: ProviderCommandEnd {
                        exit_code: None,
                        is_stopped_by_provider,
                        summary: frame
                            .summary()
                            .filter(|_| is_stopped_by_provider)
                            .map(str::to_owned),
                    },
                })
            }
            ClaudeWireFrameKind::SystemBackgroundTasksChanged => {
                let listed = self.list(frame, session_id, run_id);
                Some(ClaudeCommandFact::Listed { session_id, listed })
            }
            _ => None,
        }
    }

    /// How many tasks running no command, a helper's, a workflow's or a tool server's, the latest
    /// background set listed.
    pub(crate) fn listed_other_tasks(&self) -> usize {
        self.listed_other_tasks
    }

    /// Forgets every command task: the session's process is gone, and its commands with it.
    pub(crate) fn forget(&mut self) {
        self.calls.clear();
        self.tasks.clear();
        self.listed_other_tasks = 0;
    }

    fn start(
        &mut self,
        frame: &ClaudeTaskFrame,
        session_id: SessionId,
        run_id: Option<RunId>,
    ) -> Option<CommandStart> {
        let task_id = frame.task_id()?;
        if !is_command_task(frame.task_type()) {
            return None;
        }
        let command = frame.tool_use_id().and_then(|tool_use_id| {
            let index = self.calls.iter().position(|(id, _)| id == tool_use_id)?;
            self.calls.remove(index).map(|(_, command)| command)
        });
        // A task the background set listed first learns its call here.
        if let Some(task) = self.tasks.get_mut(task_id) {
            if task.tool_use_id.is_some() {
                return None;
            }
            task.tool_use_id = Some(frame.tool_use_id()?.to_owned());
            task.start.line = command.as_deref().map(bash_line_text);
            return Some(task.start.clone());
        }
        let is_backgrounded = frame.is_backgrounded == Some(true);
        let start = CommandStart {
            session_id,
            command_id: CommandId::new(task_id.to_owned())?,
            run_id: run_id?,
            name: command_name(frame.description.as_deref(), command.as_deref(), task_id)?,
            started_at: WireInstant::now(),
            line: command.as_deref().map(bash_line_text),
            process_id: None,
            is_backgrounded,
            can_move_to_background: !is_backgrounded,
            accepts_input: false,
        };
        self.tasks.insert(
            task_id.to_owned(),
            ClaudeCommandTask {
                tool_use_id: frame.tool_use_id().map(str::to_owned),
                start: start.clone(),
            },
        );
        Some(start)
    }

    // The command tasks of a whole background set: a task held keeps its start, and one first
    // seen here, which Claude Code lists before its start, is added on `run_id`. A background task
    // held but no longer listed ends with the reseed.
    fn list(
        &mut self,
        frame: &ClaudeTaskFrame,
        session_id: SessionId,
        run_id: Option<RunId>,
    ) -> Vec<CommandStart> {
        let entries = frame.tasks.as_ref().map_or(&[][..], |tasks| &tasks.0);
        self.listed_other_tasks = entries
            .iter()
            .filter(|entry| non_empty(entry.task_id.as_deref()).is_some())
            .filter(|entry| !is_command_task(non_empty(entry.task_type.as_deref())))
            .count();
        let listed_ids: Vec<&str> = entries
            .iter()
            .filter(|entry| is_command_task(non_empty(entry.task_type.as_deref())))
            .filter_map(|entry| non_empty(entry.task_id.as_deref()))
            .collect();
        self.tasks.retain(|task_id, task| {
            !task.start.is_backgrounded || listed_ids.contains(&&**task_id)
        });
        let mut listed = Vec::new();
        for entry in entries {
            let Some(task_id) = non_empty(entry.task_id.as_deref())
                .filter(|_| is_command_task(non_empty(entry.task_type.as_deref())))
            else {
                continue;
            };
            if let Some(task) = self.tasks.get_mut(task_id) {
                task.start.is_backgrounded = true;
                task.start.can_move_to_background = false;
                listed.push(task.start.clone());
                continue;
            }
            let Some(start) = run_id.and_then(|run_id| {
                Some(CommandStart {
                    session_id,
                    command_id: CommandId::new(task_id.to_owned())?,
                    run_id,
                    name: command_name(entry.description.as_deref(), None, task_id)?,
                    started_at: WireInstant::now(),
                    line: None,
                    process_id: None,
                    is_backgrounded: true,
                    can_move_to_background: false,
                    accepts_input: false,
                })
            }) else {
                continue;
            };
            self.tasks.insert(
                task_id.to_owned(),
                ClaudeCommandTask {
                    tool_use_id: None,
                    start: start.clone(),
                },
            );
            listed.push(start);
        }
        listed
    }
}

/// The command wrapper's and the command askpass's links, absolute, which every session process's
/// commands run under.
pub(crate) struct ClaudeCommandPrograms {
    /// The command wrapper's link, Claude Code's shell prefix.
    pub(crate) wrapper_program: PathBuf,
    /// The command askpass's link, which a command's git and ssh ask through.
    pub(crate) askpass_program: PathBuf,
}

/// Every session's command channel, one per session from its first spawn to its close: where
/// each opens, the programs its commands run under, how a party's place under the provider's
/// process is read, how a command's wait for input is read, and the running commands each
/// channel's records reach.
pub(crate) struct ClaudeCommandChannels {
    root: PathBuf,
    programs: ClaudeCommandPrograms,
    caller_processes: Arc<dyn CallerProcessReader>,
    input_waits: Arc<dyn InputWaitReader>,
    command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    sessions: Mutex<HashMap<SessionId, Arc<ClaudeCommandChannel>>>,
    // Each session's channels apart from its own, while their callers hold them.
    apart: Mutex<HashMap<SessionId, Vec<Weak<ClaudeCommandChannel>>>>,
}

/// A session's command channel as a spawn takes it: the one the session already holds, which a
/// restarted process follows, or one opened for this spawn, which a failed spawn closes.
pub(crate) enum ClaudeSessionChannel {
    /// The session's channel from an earlier spawn.
    Held(Arc<ClaudeCommandChannel>),
    /// A channel opened for this spawn.
    Opened(Arc<ClaudeCommandChannel>),
}

impl ClaudeSessionChannel {
    /// The channel.
    pub(crate) fn channel(&self) -> &Arc<ClaudeCommandChannel> {
        match self {
            Self::Held(channel) | Self::Opened(channel) => channel,
        }
    }
}

impl ClaudeCommandChannels {
    /// The channels of a daemon whose data folder is `data_folder`, its commands run under
    /// `programs`.
    pub(crate) fn new(
        data_folder: &Path,
        programs: ClaudeCommandPrograms,
        caller_processes: Arc<dyn CallerProcessReader>,
        input_waits: Arc<dyn InputWaitReader>,
        command_output: Arc<PortRegistration<Arc<RunningCommandSets>>>,
    ) -> Self {
        Self {
            root: command_channel_root(data_folder),
            programs,
            caller_processes,
            input_waits,
            command_output,
            sessions: Mutex::default(),
            apart: Mutex::default(),
        }
    }

    /// The channel of the session `session_id`'s processes: the one it holds, else one opened now,
    /// its watch made before the first process starts; `None` where the system runs no command
    /// wrapper, and while the running commands are not registered, since no record could reach a
    /// row. Fails with the system's error when the folder cannot be made or watched, or a path is
    /// no text a process environment can carry.
    pub(crate) async fn open(
        &self,
        session_id: SessionId,
    ) -> io::Result<Option<ClaudeSessionChannel>> {
        if let Some(channel) = lock(&self.sessions).get(&session_id) {
            return Ok(Some(ClaudeSessionChannel::Held(Arc::clone(channel))));
        }
        let Some(opened) = self.open_channel(session_id, None).await? else {
            return Ok(None);
        };
        lock(&self.sessions).insert(session_id, Arc::clone(&opened));
        Ok(Some(ClaudeSessionChannel::Opened(opened)))
    }

    /// A channel of its own for one process of the session `session_id` apart from its own that
    /// runs only `run_id`, such as a staged review's, whose commands are rows under that run; the
    /// caller closes it once that process ended. `None` and failures as [`Self::open`] answers
    /// them.
    pub(crate) async fn open_apart(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> io::Result<Option<Arc<ClaudeCommandChannel>>> {
        let opened = self.open_channel(session_id, Some(run_id)).await?;
        if let Some(opened) = &opened {
            let mut apart = lock(&self.apart);
            let channels = apart.entry(session_id).or_default();
            channels.retain(|channel| channel.strong_count() > 0);
            channels.push(Arc::downgrade(opened));
        }
        Ok(opened)
    }

    /// The running command `task_id` of a process of `session_id` apart from its own, with the
    /// process it runs in; `None` where no such process runs it.
    pub(crate) fn apart_command(
        &self,
        session_id: SessionId,
        task_id: &str,
    ) -> Option<ClaudeApartCommand> {
        let channels: Vec<_> = lock(&self.apart)
            .get(&session_id)?
            .iter()
            .filter_map(Weak::upgrade)
            .collect();
        channels
            .iter()
            .filter_map(|channel| channel.apart_run.as_ref())
            .find_map(|apart_run| apart_run.held_command(task_id))
    }

    // A channel for a process of `session_id`, reading its task frames onto `apart_run` where it
    // runs only that run.
    async fn open_channel(
        &self,
        session_id: SessionId,
        apart_run: Option<RunId>,
    ) -> io::Result<Option<Arc<ClaudeCommandChannel>>> {
        if !RUNS_COMMAND_WRAPPER {
            return Ok(None);
        }
        let Some(sets) = self.command_output.port().cloned() else {
            return Ok(None);
        };
        let folder = self
            .root
            .join(session_id.to_string())
            .join(mint_uuid_v7().to_string());
        let caller_processes = Arc::clone(&self.caller_processes);
        // The open makes its folders, a blocking call.
        let channel = Arc::new(
            tokio::task::spawn_blocking(move || CommandChannel::open(folder, caller_processes))
                .await
                .map_err(io::Error::other)??,
        );
        match self
            .follow_ready(session_id, apart_run, &channel, sets)
            .await
        {
            Ok(opened) => Ok(Some(opened)),
            // A channel that cannot be followed takes its folder with it.
            Err(error) => {
                if let Err(close_error) = channel.close().await {
                    tracing::warn!(
                        %session_id,
                        error = &close_error as &(dyn std::error::Error + 'static),
                        "a command channel that could not be readied left its folder behind"
                    );
                }
                Err(error)
            }
        }
    }

    // The opened `channel` readied for its process: its environment and its watch.
    async fn follow_ready(
        &self,
        session_id: SessionId,
        apart_run: Option<RunId>,
        channel: &Arc<CommandChannel>,
        sets: Arc<RunningCommandSets>,
    ) -> io::Result<Arc<ClaudeCommandChannel>> {
        let mut environment = channel
            .environment()
            .into_iter()
            .map(|(name, value)| Ok((name.to_owned(), environment_text(value)?)))
            .collect::<io::Result<Vec<_>>>()?;
        environment.extend([
            (
                CLAUDE_SHELL_PREFIX_COMMAND.variable.to_owned(),
                environment_text(self.programs.wrapper_program.clone().into_os_string())?,
            ),
            (
                COMMAND_PROVIDER_VARIABLE.to_owned(),
                DESCRIPTOR.id.to_owned(),
            ),
        ]);
        environment.extend(
            command_prompt_environment(&self.programs.askpass_program)
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value)),
        );
        let watch = channel.watch().await?;
        Ok(Arc::new(ClaudeCommandChannel {
            session_id,
            channel: Arc::clone(channel),
            environment,
            apart_run: apart_run
                .map(|run_id| ClaudeApartRunCommands::new(session_id, run_id, Arc::clone(&sets))),
            sets,
            input_waits: Arc::clone(&self.input_waits),
            watch: Mutex::new(Some(watch)),
            follower: Mutex::new(None),
        }))
    }

    /// Closes the session `session_id`'s channel, once the session ended or its first spawn
    /// failed; nothing for a session that holds none. Fails with the system's error when the
    /// channel's folder cannot be removed.
    pub(crate) async fn close(&self, session_id: SessionId) -> io::Result<()> {
        lock(&self.apart).remove(&session_id);
        let channel = lock(&self.sessions).remove(&session_id);
        match channel {
            Some(channel) => channel.close().await,
            None => Ok(()),
        }
    }
}

/// One session process's command channel, open before the process starts and followed once it
/// runs.
pub(crate) struct ClaudeCommandChannel {
    session_id: SessionId,
    channel: Arc<CommandChannel>,
    environment: Vec<(String, String)>,
    apart_run: Option<ClaudeApartRunCommands>,
    sets: Arc<RunningCommandSets>,
    input_waits: Arc<dyn InputWaitReader>,
    watch: Mutex<Option<FolderArrivalWatch>>,
    follower: Mutex<Option<JoinHandle<()>>>,
}

impl ClaudeCommandChannel {
    /// The variables the process's commands carry so they run under the wrapper, which reaches
    /// the channel, and their git and ssh ask through the askpass.
    pub(crate) fn environment(&self) -> &[(String, String)] {
        &self.environment
    }

    /// The task frames' reading of a process apart from the session's own, whose commands are rows
    /// under its one run; `None` for the session's own channel, whose stream reads them.
    pub(crate) fn apart_run(&self) -> Option<&ClaudeApartRunCommands> {
        self.apart_run.as_ref()
    }

    /// The channel's folder, which the process's sandbox lets its commands write.
    pub(crate) fn folder(&self) -> &Path {
        self.channel.folder()
    }

    /// The folder of the daemon's requests to its parties, which the sandbox keeps read-only.
    pub(crate) fn requests_folder(&self) -> PathBuf {
        self.channel.requests_folder()
    }

    /// Binds the channel to the started process `provider_process_id` and follows its records into
    /// the session's running commands; a later call, for a restarted process, only binds it.
    pub(crate) fn follow(&self, provider_process_id: u32) {
        self.channel.bind(provider_process_id);
        let Some(watch) = lock(&self.watch).take() else {
            return;
        };
        let session_id = self.session_id;
        let followed = follow_channel_records(
            session_id,
            Arc::clone(&self.channel),
            watch,
            Arc::clone(&self.sets),
            Arc::clone(&self.input_waits),
        );
        *lock(&self.follower) = Some(tokio::spawn(async move {
            // The watch failing ends the following; the commands' rows keep what the provider
            // reports, without their output, input waits or prompts.
            if let Err(error) = followed.await {
                tracing::error!(
                    %session_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a Claude Code process's command channel stopped being followed"
                );
            }
        }));
    }

    /// Stops following and removes the channel, once every process it served ended; a restarted
    /// process of the session follows the same channel instead. Fails with the system's error
    /// when the folder cannot be removed.
    pub(crate) async fn close(&self) -> io::Result<()> {
        if let Some(follower) = lock(&self.follower).take() {
            follower.abort();
        }
        self.channel.close().await
    }
}

/// Whether a task of `task_type` is a shell or Monitor command: any kind but a helper, a workflow
/// and a tool server's task. A task of no kind cannot be told from a helper, so it is none.
fn is_command_task(task_type: Option<&str>) -> bool {
    task_type.is_some_and(|task_type| {
        ![
            CLAUDE_HELPER_TASK_TYPE,
            CLAUDE_WORKFLOW_TASK_TYPE,
            CLAUDE_TOOL_SERVER_TASK_TYPE,
        ]
        .contains(&task_type)
    })
}

// A command's name on its row: Claude Code's description of it, else its line, else its id.
fn command_name(
    description: Option<&str>,
    command: Option<&str>,
    task_id: &str,
) -> Option<NonEmptyText> {
    [description, command, Some(task_id)]
        .into_iter()
        .flatten()
        .find_map(|text| NonEmptyText::new(text.to_owned()))
}

// `value` as the text a process environment carries.
fn environment_text(value: OsString) -> io::Result<String> {
    value.into_string().map_err(|value| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the path {} is no text", value.to_string_lossy()),
        )
    })
}

fn non_empty(text: Option<&str>) -> Option<&str> {
    text.filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests;
