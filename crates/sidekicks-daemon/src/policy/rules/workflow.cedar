// An agent's workflow tools, and each run a trigger fires, act for the machine's owning user, who
// may author, start, cancel and resume every workflow on the machine.
permit (
  principal is User,
  action in [
    Action::"workflow::author",
    Action::"workflow::start",
    Action::"workflow::cancel",
    Action::"workflow::resume"
  ],
  resource
);
