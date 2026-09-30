import {
  McpCapabilityUnavailableError,
  PositiveInt,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadEnvMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 50;
export const MAX_READ_TURNS = 20;
export const DEFAULT_READ_TURNS = 3;
export const MAX_LIST_THREADS = 200;
export const DEFAULT_LIST_THREADS = 50;
export const MAX_WAIT_THREADS = 20;

/**
 * Where a thread stands, as the sidebar shows it. `starting` includes a
 * message that is queued but not yet picked up by the agent.
 */
export const ThreadStatus = Schema.Literals([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "idle",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ThreadSummary = Schema.Struct({
  threadId: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  status: ThreadStatus,
  lastError: Schema.NullOr(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  isCurrentThread: Schema.Boolean.annotate({
    description: "True for the thread this agent is running in.",
  }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ThreadSummary = typeof ThreadSummary.Type;

const ThreadIdInput = TrimmedNonEmptyString.annotate({
  description: "Thread id, as returned by list_threads or create_thread.",
});

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found. It may have been deleted; archived threads are only listed with includeArchived.`;
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found. Call list_projects for valid ids.`;
  }
}

export class ThreadIsCurrentThreadError extends Schema.TaggedError<ThreadIsCurrentThreadError>()(
  "ThreadIsCurrentThreadError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `You cannot ${this.operation} the thread you are running in.`;
  }
}

export class ThreadRuntimeModeNotAllowedError extends Schema.TaggedError<ThreadRuntimeModeNotAllowedError>()(
  "ThreadRuntimeModeNotAllowedError",
  { requested: RuntimeMode, allowed: RuntimeMode },
) {
  override get message(): string {
    return `This thread runs in ${this.allowed} mode, so it can only start work that runs in ${this.allowed} mode or a more restricted one, not ${this.requested}. Ask the user to change the mode if more access is needed.`;
  }
}

export class WorktreeBaseBranchRequiredError extends Schema.TaggedError<WorktreeBaseBranchRequiredError>()(
  "WorktreeBaseBranchRequiredError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return "The project's checkout has no current branch to start a worktree from. Pass baseBranch, or use workspace local.";
  }
}

export class ThreadToolFailedError extends Schema.TaggedError<ThreadToolFailedError>()(
  "ThreadToolFailedError",
  { operation: Schema.String, detail: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Could not ${this.operation}.`
      : `Could not ${this.operation}: ${this.detail}`;
  }
}

export const ThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadNotFoundError,
  ProjectNotFoundError,
  ThreadIsCurrentThreadError,
  ThreadRuntimeModeNotAllowedError,
  WorktreeBaseBranchRequiredError,
  ThreadToolFailedError,
]);
export type ThreadToolError = typeof ThreadToolError.Type;

const ListProjectsTool = Tool.make("list_projects", {
  description:
    "List the projects in this T3 Code environment. Use a projectId with list_threads or create_thread to work in another project.",
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        title: Schema.String,
        workspaceRoot: Schema.String,
        isCurrentProject: Schema.Boolean,
      }),
    ),
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadsTool = Tool.make("list_threads", {
  description:
    "List threads in this T3 Code environment, most recently updated first, with each thread's status (running, waiting_for_approval, completed, ...). Includes the thread you are running in, marked isCurrentThread.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Only list threads of this project. Defaults to every project.",
      }),
    ),
    includeArchived: Schema.optional(
      Schema.Boolean.annotate({ description: "Also list archived threads. Defaults to false." }),
    ),
    limit: Schema.optional(
      PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIST_THREADS)).annotate({
        description: `Maximum threads to return. Defaults to ${DEFAULT_LIST_THREADS}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    threads: Schema.Array(ThreadSummary),
    truncated: Schema.Boolean.annotate({
      description: "True when more threads matched than limit allowed.",
    }),
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadMessageEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  createdAt: Schema.String,
});
export type ThreadMessageEntry = typeof ThreadMessageEntry.Type;

const ReadThreadTool = Tool.make("read_thread", {
  description:
    "Read a thread's status and the user and assistant messages of its most recent turns. Long messages are shortened; the newest messages are kept.",
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    turns: Schema.optional(
      PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_READ_TURNS)).annotate({
        description: `How many recent turns to read. Defaults to ${DEFAULT_READ_TURNS}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    thread: ThreadSummary,
    messages: Schema.Array(ThreadMessageEntry),
    hasOlderMessages: Schema.Boolean,
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateThreadTool = Tool.make("create_thread", {
  description:
    "Start a new thread with its own agent and send it a first message. The thread shows up in the user's sidebar and runs in parallel with you; use wait_for_threads to wait for its reply and read_thread to see its work. The message is marked as coming from your thread so the new agent knows who asked. Returns once the agent has started, or with status preparing while a new worktree is still being set up.",
  parameters: Schema.Struct({
    message: TrimmedNonEmptyString.annotate({
      description:
        "The first message for the new agent. It does not see your conversation, so include everything it needs.",
    }),
    projectId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Project to start the thread in. Defaults to your thread's project.",
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Thread title. Defaults to a title generated from the message.",
      }),
    ),
    workspace: Schema.optional(
      ThreadEnvMode.annotate({
        description:
          "worktree gives the thread its own git worktree and branch, so parallel threads do not edit the same files; local runs in the project's checkout. Defaults to the project's new-thread setting.",
      }),
    ),
    baseBranch: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Branch the new worktree starts from. Defaults to the branch currently checked out in the project. Ignored for workspace local.",
      }),
    ),
    provider: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Provider instance id to run the agent on, for example codex or claudeAgent. Defaults to the project's default model, else yours.",
      }),
    ),
    model: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Model id for that provider. Defaults like provider.",
      }),
    ),
    runtimeMode: Schema.optional(
      RuntimeMode.annotate({
        description:
          "What the new agent may do without asking the user. Defaults to your own mode, which is also the most it may be.",
      }),
    ),
    interactionMode: Schema.optional(
      ProviderInteractionMode.annotate({
        description: "plan asks the agent to propose a plan before changing anything.",
      }),
    ),
  }),
  success: Schema.Struct({
    thread: ThreadSummary,
    preparing: Schema.Boolean.annotate({
      description:
        "True while the worktree or its setup script is still being prepared; the agent starts on its own when that finishes.",
    }),
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SendThreadMessageTool = Tool.make("send_thread_message", {
  description:
    "Send a message to another thread's agent, as if the user typed it there, marked as coming from your thread. If that agent is busy, the message waits its turn the same way a user's would. Use wait_for_threads to wait for the reply.",
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    message: TrimmedNonEmptyString.annotate({
      description: "The message. The other agent does not see your conversation.",
    }),
  }),
  success: Schema.Struct({
    thread: ThreadSummary,
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send message to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WaitedThread = Schema.Struct({
  thread: ThreadSummary,
  finished: Schema.Boolean.annotate({
    description:
      "True when the thread is no longer starting or running: completed, failed, idle, or waiting on the user.",
  }),
  lastAssistantMessage: Schema.NullOr(Schema.String),
  lastAssistantMessageTruncated: Schema.Boolean,
});
export type WaitedThread = typeof WaitedThread.Type;

const WaitForThreadsTool = Tool.make("wait_for_threads", {
  description: `Wait until other threads finish their current work, then return each one's status and last assistant message. A thread counts as finished once it is not starting or running, including when it stops to wait for the user's approval or answer. Returns early with timedOut=true after timeoutSeconds; call again to keep waiting.`,
  parameters: Schema.Struct({
    threadIds: Schema.Array(ThreadIdInput)
      .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_WAIT_THREADS))
      .annotate({ description: "Threads to wait on." }),
    until: Schema.optional(
      Schema.Literals(["all", "any"]).annotate({
        description: "all waits for every thread, any for the first. Defaults to all.",
      }),
    ),
    timeoutSeconds: Schema.optional(
      PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_WAIT_SECONDS)).annotate({
        description: `Longest to wait. Defaults to ${DEFAULT_WAIT_SECONDS}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    threads: Schema.Array(WaitedThread),
    timedOut: Schema.Boolean,
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const InterruptThreadTool = Tool.make("interrupt_thread", {
  description:
    "Stop another thread's current turn, like the user pressing stop. The thread keeps its history and can be messaged again.",
  parameters: Schema.Struct({ threadId: ThreadIdInput }),
  success: Schema.Struct({
    thread: ThreadSummary,
    wasRunning: Schema.Boolean,
  }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateThreadTool = Tool.make("update_thread", {
  description:
    "Rename, archive, unarchive, settle, or unsettle a thread. Archiving stops its agent and hides it from the sidebar; unarchive brings it back. Settling marks it done in the sidebar without stopping anything. Pass only what should change.",
  parameters: Schema.Struct({
    threadId: ThreadIdInput,
    title: Schema.optional(TrimmedNonEmptyString.annotate({ description: "New title." })),
    archived: Schema.optional(Schema.Boolean),
    settled: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ thread: ThreadSummary }),
  failure: ThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(
  ListProjectsTool,
  ListThreadsTool,
  ReadThreadTool,
  CreateThreadTool,
  SendThreadMessageTool,
  WaitForThreadsTool,
  InterruptThreadTool,
  UpdateThreadTool,
);
