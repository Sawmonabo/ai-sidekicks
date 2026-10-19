//! All operating-system code behind one interface the other crates call: the interface's shared
//! types, a module per platform supplying the running system's implementation (`macos`, `linux`,
//! `windows`, and `posix` for what the first two share), the `memory` module, which reads the
//! installed memory on every system, the `path` module, which reads a path by either system's rules
//! on every system, and the `wsl` module, which reads the WSL distribution a Windows path names on
//! every system.
#![expect(
    unsafe_code,
    reason = "the terminal's window size, mode read (`tcgetattr`), signal request (`TIOCSIG`), \
              console, console input count (`GetNumberOfConsoleInputEvents`) and library-search \
              calls, the shell start's signal and console-handler calls, the parent check \
              a `Command` child runs in `pre_exec`, a lasting child's `setsid` and `prctl` in \
              `pre_exec`, the stop of a pinned process (Linux's `pidfd_send_signal`, macOS's \
              exit filter, descendant list and audit-token signal, Windows' `OpenProcess`, \
              `GetProcessTimes`, `WaitForSingleObject`, `TerminateProcess` and its job's open, \
              check and end), a lasting child's start on Windows (`CreateProcessW` with its \
              attribute list, its job's creation and access list, the handles it inherits and \
              the wait for its exit), the user-namespace check's `unshare` and map writes, the \
              boot id's `sysctl`, the Windows host-name, free-room and file-information calls, \
              the Windows replacing rename's `MoveFileExW`, the caller reads (Linux's peer \
              process descriptor and `pidfd_open`, macOS's audit token, checked process reads \
              and responsible-process reads), macOS's code-signature checks, the start as its \
              own responsible process (its thread count, its program's path, its marker's \
              removal from the environment and the disclaiming exec), the socket pair a shell's \
              start is confirmed over, macOS's `proc_pid_rusage`, which a process's peak \
              memory and the measurement tests' footprint share, Windows' `OpenProcess` and \
              `K32GetProcessMemoryInfo`, the available-memory reads (macOS's `mach_host_self` and \
              `host_statistics64`, Windows' `GlobalMemoryStatusEx`), macOS's process list \
              (`proc_listpids`) and environment read (`sysctl` of `KERN_ARGMAX` and \
              `KERN_PROCARGS2`), a released terminal's wait for its program (`waitid`, and its \
              exit event's registration), mimalloc's `mi_collect`, tree-sitter's \
              `set_allocator`, and the power notifications and wall-clock timers of macOS and \
              Windows are C interfaces, and tokio's watch of the Linux timer's and the terminal \
              poller's descriptors trusts each to stay open while it watches, and the Windows \
              Ctrl-C ending's `ExitProcess`, the user's locale reads (Windows' \
              `GetLocaleInfoEx`, macOS's `CFDateFormatterCreateDateFormatFromTemplate`), a \
              process's user read from its token (`OpenProcess`, `OpenProcessToken`, \
              `GetTokenInformation`, `EqualSid`, `ConvertSidToStringSidW`), the named pipe's \
              server read (`GetNamedPipeServerProcessId`), a Windows AF_UNIX socket's peer read \
              (`WSAIoctl` of `SIO_AF_UNIX_GETPEERPID`) and the mark that lets `async-io` drive \
              it (`IoSafe`), the run folder's owner and access \
              list (`GetSecurityInfo`, `GetAce`, `IsWellKnownSid`) and a Windows child's output \
              read at its exit (`CancelIoEx`, `PeekNamedPipe`) are C interfaces too"
)]

mod atomic_replace;
mod caller_process;
mod child_command;
mod child_tree;
mod code_signature;
mod credential_store;
mod entry_identity;
mod executable_search;
mod file_facts;
#[cfg(any(test, feature = "test-support"))]
mod footprint;
mod lasting_child;
#[cfg(target_os = "linux")]
mod linux;
mod machine_name;
#[cfg(target_os = "macos")]
mod macos;
mod memory;
mod own_root;
mod path;
mod pinned_process;
#[cfg(unix)]
mod posix;
mod program_install_folders;
mod program_start;
mod run_folder;
mod running_program;
mod shell_folder_start;
mod shell_start;
mod socket;
mod spawner;
mod system_folder;
mod system_locale;
mod terminal;
#[cfg(not(target_os = "linux"))]
mod user_namespace;
mod wake_watch;
mod wall_clock;
#[cfg(target_os = "windows")]
mod windows;
mod wsl;

pub use atomic_replace::{ReplaceFileError, replace_file_atomically};
#[cfg(not(target_os = "macos"))]
pub use caller_process::read_responsible_process;
pub use caller_process::{ParentProcess, ResponsibleProcess};
#[cfg(not(target_os = "linux"))]
pub use child_command::leave_daemon_scope;
pub use child_command::{ChildEnd, ChildExit, read_child_exit};
pub use child_tree::{ChildTree, ChildTreeOutput, ChildTreeOutputError, start_child_tree};
#[cfg(not(target_os = "macos"))]
pub use code_signature::DesktopClientRequirement;
pub use code_signature::{CodeSignatureError, SignatureCheck};
#[cfg(any(test, feature = "test-support"))]
pub use credential_store::blocking::BlockingCredentialStore;
pub use credential_store::{CredentialStore, CredentialStoreError};
pub use entry_identity::{EntryIdentity, IdentifiedEntry, NotAnEntryIdentity};
pub use executable_search::{find_executables, user_programs_folder};
pub use file_facts::FileFacts;
#[cfg(any(test, feature = "test-support"))]
pub use footprint::ProcessFootprint;
pub use lasting_child::{LastingChild, LastingCommand};
#[cfg(all(target_os = "linux", any(test, feature = "test-support")))]
pub use linux::SHELL_FOLDER_PROBES;
// The daemon's own socket on macOS and Linux is AF_UNIX too, so one peer read serves both.
#[cfg(target_os = "linux")]
pub use linux::caller_process::{
    read_parent_process, read_peer_process, read_peer_process as unix_domain_peer_process,
};
#[cfg(target_os = "linux")]
pub use linux::memory::{
    available_memory, read_process_peak_bytes, turn_off_transparent_huge_pages,
};
#[cfg(all(target_os = "linux", any(test, feature = "test-support")))]
pub use linux::pinned_process::this_process;
#[cfg(target_os = "linux")]
pub use linux::pinned_process::{PinnedProcess, pin_child_process};
#[cfg(all(target_os = "linux", any(test, feature = "test-support")))]
pub use linux::process_footprint;
#[cfg(target_os = "linux")]
pub use linux::processes::{list_user_process_ids, read_process_environment};
#[cfg(target_os = "linux")]
pub use linux::read_command_argument_limit;
#[cfg(target_os = "linux")]
pub use linux::user_namespace::can_create_user_namespace;
#[cfg(target_os = "linux")]
pub use linux::user_scope::leave_daemon_scope;
#[cfg(target_os = "linux")]
pub use linux::{SHOULD_MEMORY_MAP_READS, machine_name, windows_drive_mounts};
#[cfg(target_os = "linux")]
pub use linux::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
pub use machine_name::MachineNameError;
#[cfg(all(target_os = "macos", any(test, feature = "test-support")))]
pub use macos::SHELL_FOLDER_PROBES;
#[cfg(target_os = "macos")]
pub use macos::caller_process::{
    read_parent_process, read_peer_process, read_peer_process as unix_domain_peer_process,
    read_responsible_process,
};
#[cfg(target_os = "macos")]
pub use macos::code_signature::DesktopClientRequirement;
#[cfg(all(target_os = "macos", any(test, feature = "test-support")))]
pub use macos::memory::process_footprint;
#[cfg(target_os = "macos")]
pub use macos::memory::{
    available_memory, read_process_peak_bytes, turn_off_transparent_huge_pages,
};
#[cfg(all(target_os = "macos", any(test, feature = "test-support")))]
pub use macos::pinned_process::this_process;
#[cfg(target_os = "macos")]
pub use macos::pinned_process::{PinnedProcess, pin_child_process};
#[cfg(target_os = "macos")]
pub use macos::processes::{list_user_process_ids, read_process_environment};
#[cfg(target_os = "macos")]
pub use macos::read_command_argument_limit;
#[cfg(target_os = "macos")]
pub use macos::responsibility::become_own_root;
#[cfg(target_os = "macos")]
pub use macos::shell_start_confirmation::ShellStartConfirmation;
#[cfg(target_os = "macos")]
pub use macos::{SHOULD_MEMORY_MAP_READS, machine_name, windows_drive_mounts};
#[cfg(target_os = "macos")]
pub use macos::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
pub use memory::physical_memory;
pub use own_root::OwnRootError;
#[cfg(not(target_os = "macos"))]
pub use own_root::become_own_root;
pub use path::program_output::path_from_program_output;
pub use path::resolution::{resolve_path, resolve_path_against};
pub use path::rules::{PathRules, ShellWordRefused};
pub use pinned_process::ProcessRecord;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use posix::allocator::{
    GLOBAL_ALLOCATOR, GlobalAllocator, collect_freed_memory, install_tree_sitter_allocator,
};
#[cfg(unix)]
pub use posix::askpass::askpass_listener;
#[cfg(unix)]
pub use posix::child_command::{
    CAN_SIGNAL_A_STOP, ask_child_to_stop, lasting_child_asked_end, prepare_child_command,
    spawn_lasting_child, wrap_child_command,
};
#[cfg(unix)]
pub use posix::ctrl_c::{CtrlCListener, ctrl_c, end_as_ctrl_c};
#[cfg(unix)]
pub use posix::disk::{
    flush_file, flush_folder, flush_open_file, read_exact_at, volume_free_bytes,
};
#[cfg(unix)]
pub use posix::entry_identity::entry_identity;
#[cfg(unix)]
pub use posix::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(unix)]
pub use posix::file_facts::file_facts;
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::file_system::UnremovableFile;
#[cfg(unix)]
pub use posix::file_system::{
    CAN_RENAME_REPLACE_EMPTY_FOLDER, create_new_file, remove_tree, rename_replacing,
};
#[cfg(unix)]
pub use posix::login_shell::login_shell;
#[cfg(unix)]
pub use posix::null_device::NULL_DEVICE_PATH;
#[cfg(unix)]
pub use posix::private_folder::create_private_folder;
#[cfg(unix)]
pub use posix::real_path::real_path;
#[cfg(unix)]
pub use posix::run_folder::{check_private_run_folder, daemon_run_folder};
#[cfg(unix)]
pub use posix::shell_folder_start::shell_folder_start;
#[cfg(unix)]
pub use posix::shell_start::{
    LOGIN_SHELL_ARGUMENTS, arm_parent_death, default_shell, prepare_shell_start, start_program,
};
// The daemon's own socket on macOS and Linux is AF_UNIX too, so one dial serves both.
#[cfg(unix)]
pub use posix::socket::connection::{
    UnixDomainStream, connect_unix_domain_socket, connect_unix_domain_socket as connect_socket,
};
#[cfg(unix)]
pub use posix::socket::listener::bind_socket_listener;
#[cfg(unix)]
pub use posix::socket::path::check_socket_path;
#[cfg(unix)]
pub use posix::system_locale::{system_hour_cycle, system_locale};
#[cfg(unix)]
pub use posix::terminal::{
    DOES_CONSOLE_COUNT_WAITING_INPUT, DOES_PAUSED_READ_HOLD_INPUT, TerminalWatch, child_process_id,
    end_process_tree, read_console, read_console_waiting_input, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
    write_console_waiting_input,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::terminal::{
    abnormal_exit, device_attribute_asker, echo_program, echoing_line_reader, input_recorder,
    interruptible_sleeper, key_stopped_printer, pass_through_start, start_confirmation_reader,
    waiting_printer,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::uptime::uptime_line;
#[cfg(unix)]
pub use posix::xdg_data_folders::XDG_DEFAULT_DATA_FOLDERS;
pub use program_install_folders::{ProgramFolder, program_install_folders};
pub use program_start::{ProgramStart, program_start};
pub use run_folder::{DaemonRunFolder, RunFolderRefused};
pub use running_program::{RUNNING_ARCH, RunningProgramPath, read_running_program_path};
#[cfg(any(test, feature = "test-support"))]
pub use shell_folder_start::ShellFolderProbe;
pub use shell_folder_start::ShellFolderStart;
#[cfg(not(target_os = "macos"))]
pub use shell_start::ShellStartConfirmation;
pub use shell_start::{ShellStart, ShellStartError};
pub use socket::listener::ExistingSocket;
pub use socket::path::SocketPathRefused;
pub use spawner::Spawner;
pub use system_folder::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};
pub use system_locale::LocaleCategory;
#[cfg(any(test, feature = "test-support"))]
pub use terminal::{AbnormalExit, TestProgram};
pub use terminal::{
    CONSOLE_WAITING_INPUT_ARGUMENT, ConsoleReading, HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd,
    TerminalInputRefusal, TerminalSignal, TerminalSignalRoute, TerminalWake, TerminalWaker,
};
#[cfg(not(target_os = "linux"))]
pub use user_namespace::can_create_user_namespace;
pub use wake_watch::WakeWatchError;
pub use wall_clock::{WallClock, WallClockWait};
#[cfg(target_os = "windows")]
pub use windows::allocator::{
    GLOBAL_ALLOCATOR, GlobalAllocator, collect_freed_memory, install_tree_sitter_allocator,
};
#[cfg(target_os = "windows")]
pub use windows::askpass::askpass_listener;
#[cfg(target_os = "windows")]
pub use windows::caller_process::{
    read_parent_process, read_peer_process, unix_domain_peer_process,
};
#[cfg(target_os = "windows")]
pub use windows::child_command::{
    CAN_SIGNAL_A_STOP, ask_child_to_stop, lasting_child_asked_end, prepare_child_command,
    wrap_child_command,
};
#[cfg(target_os = "windows")]
pub use windows::command_argument_limit::read_command_argument_limit;
#[cfg(target_os = "windows")]
pub use windows::ctrl_c::{CtrlCListener, ctrl_c, end_as_ctrl_c};
#[cfg(target_os = "windows")]
pub use windows::disk::{
    FlushFailure, SHOULD_MEMORY_MAP_READS, flush_file, flush_folder, flush_open_file,
    read_exact_at, volume_free_bytes, windows_drive_mounts,
};
#[cfg(target_os = "windows")]
pub use windows::entry_identity::entry_identity;
#[cfg(target_os = "windows")]
pub use windows::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(target_os = "windows")]
pub use windows::file_facts::file_facts;
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::file_system::UnremovableFile;
#[cfg(target_os = "windows")]
pub use windows::file_system::{
    CAN_RENAME_REPLACE_EMPTY_FOLDER, create_new_file, remove_tree, rename_replacing,
};
#[cfg(target_os = "windows")]
pub use windows::lasting_child::spawn_lasting_child;
#[cfg(target_os = "windows")]
pub use windows::login_shell::login_shell;
#[cfg(target_os = "windows")]
pub use windows::machine_name::machine_name;
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::measurement::{process_footprint, uptime_line};
#[cfg(target_os = "windows")]
pub use windows::memory::{
    available_memory, read_process_peak_bytes, turn_off_transparent_huge_pages,
};
#[cfg(target_os = "windows")]
pub use windows::null_device::NULL_DEVICE_PATH;
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::pinned_process::this_process;
#[cfg(target_os = "windows")]
pub use windows::pinned_process::{PinnedProcess, pin_child_process};
#[cfg(target_os = "windows")]
pub use windows::private_folder::create_private_folder;
#[cfg(target_os = "windows")]
pub use windows::processes::{list_user_process_ids, read_process_environment};
#[cfg(target_os = "windows")]
pub use windows::real_path::real_path;
#[cfg(target_os = "windows")]
pub use windows::run_folder::{check_private_run_folder, daemon_run_folder};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::shell_folder_start::SHELL_FOLDER_PROBES;
#[cfg(target_os = "windows")]
pub use windows::shell_folder_start::shell_folder_start;
#[cfg(target_os = "windows")]
pub use windows::shell_start::{
    LOGIN_SHELL_ARGUMENTS, arm_parent_death, default_shell, prepare_shell_start, start_program,
};
#[cfg(target_os = "windows")]
pub use windows::socket::connection::connect_socket;
#[cfg(target_os = "windows")]
pub use windows::socket::listener::bind_socket_listener;
#[cfg(target_os = "windows")]
pub use windows::socket::path::check_socket_path;
#[cfg(target_os = "windows")]
pub use windows::socket::unix_domain::{UnixDomainStream, connect_unix_domain_socket};
#[cfg(target_os = "windows")]
pub use windows::system_locale::{system_hour_cycle, system_locale};
#[cfg(target_os = "windows")]
pub use windows::terminal::{
    DOES_CONSOLE_COUNT_WAITING_INPUT, DOES_PAUSED_READ_HOLD_INPUT, TerminalWatch, child_process_id,
    end_process_tree, read_console, read_console_waiting_input, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
    write_console_waiting_input,
};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::terminal::{
    abnormal_exit, device_attribute_asker, echo_program, echoing_line_reader, input_recorder,
    interruptible_sleeper, key_stopped_printer, pass_through_start, start_confirmation_reader,
    waiting_printer,
};
#[cfg(target_os = "windows")]
pub use windows::xdg_data_folders::XDG_DEFAULT_DATA_FOLDERS;
#[cfg(target_os = "windows")]
pub use windows::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
pub use wsl::{DistributionPath, distribution_of};
