# Agents working with other threads

An agent can start, message, and wait on other threads in the same environment. Ask it to split
work across parallel threads, hand a task to a thread on another project, or check on a thread
that is already running. Every thread it starts shows up in your sidebar like any other, and
messages it sends are marked with the thread they came from.

Agents can:

- list projects and threads, and read a thread's recent messages and status
- start a thread with a first message, in a new worktree or the project's checkout, on any
  provider and model you have set up
- message a thread, wait for threads to finish, and stop a running turn
- rename, archive, unarchive, settle, and unsettle threads

An agent cannot give another thread more access than it has. A thread running in **Auto-accept
edits** can only start or message threads that run in that mode or a more restricted one. Agents
cannot delete threads.

Turn this off in **Settings → Integrations → Agent thread access**, or per project with the project
selected. Changes apply when an agent session next starts.
