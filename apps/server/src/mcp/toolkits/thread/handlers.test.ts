import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";

const id = ThreadId.make("question-caller");
const requestId = RuntimeRequestId.make("permission-request");
const questions = [
  { header: "Choice", question: "Which approach?", options: [{ label: "Minimal" }] },
];
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "questions", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "questions", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const harness = Effect.fn("questionToolkitHarness")(function* (
  fields: Partial<OrchestrationV2ThreadShell> = {},
) {
  const shell = { ...liveThreadShell(id), ...fields };
  const commands: OrchestrationV2ServerCommand[] = [];
  const projection = idleThreadProjection(shell);
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
      getProjectThreadRecords: () =>
        Effect.succeed({
          ...projection,
          runtimeRequests: [
            {
              id: requestId,
              nodeId: NodeId.make("permission"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: shell.createdAt,
              resolvedAt: null,
            },
          ],
        }),
    }),
  );
  const server = yield* McpServer.McpServer.pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(dependencies),
      ),
    ),
  );
  const call = (
    name: string,
    args: Record<string, unknown>,
    overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
  ) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.map((result) => ({
        error: result.isError === true,
        value: result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text),
      })),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "question-session",
        thread: {
          threadId: id,
          providerSessionId: "question-session",
          providerInstanceId: shell.providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
        ...overrides,
      }),
      Effect.provide(dependencies),
    );
  return { call, commands, server };
});

it.effect.each(["full-access", "auto-accept-edits", "approval-required"] as const)(
  "asks through production MCP registration in %s without elevating permissions",
  (runtimeMode) =>
    Effect.gen(function* () {
      const h = yield* harness({ runtimeMode, interactionMode: "plan" });
      const result = yield* h.call("t3_ask_user_question", { questions });
      expect(result.error).toBe(false);
      expect(h.commands).toHaveLength(1);
      expect(h.commands[0]).toMatchObject({
        type: "thread.user-input.request",
        threadId: id,
        providerSessionId: "question-session",
        runId: "run:mcp-test",
        requestId: result.value.requestId,
        questions: [
          {
            id: "1",
            header: "Choice",
            question: "Which approach?",
            multiSelect: false,
            allowCustomAnswer: true,
            options: [{ label: "Minimal", description: "Minimal" }],
          },
        ],
      });
    }),
);

it.effect("refuses stale callers, missing grants and external clients before dispatch", () =>
  Effect.gen(function* () {
    const inactive = yield* harness({ activeRunId: null });
    expect((yield* inactive.call("t3_ask_user_question", { questions })).value.code).toBe(
      "parent_not_active",
    );
    expect(inactive.commands).toHaveLength(0);
    const h = yield* harness();
    expect(
      (yield* h.call("t3_ask_user_question", { questions }, { capabilities: new Set<never>() }))
        .value.code,
    ).toBe("capability_denied");
    expect(
      (yield* h.call("t3_ask_user_question", { questions }, { thread: undefined })).value.code,
    ).toBe("thread_credential_required");
    expect(h.commands).toHaveLength(0);
  }),
);

it.effect("pending question tools cannot expose or approve a permission request", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    expect((yield* h.call("t3_pending_request_list", {})).value).toEqual({ requestIds: [] });
    expect((yield* h.call("t3_pending_request_read", { requestId })).value.code).toBe(
      "invalid_request",
    );
    expect(
      (yield* h.call("t3_pending_request_respond", { requestId, answers: { "1": "Approve" } }))
        .value.code,
    ).toBe("invalid_request");
    expect(h.commands).toHaveLength(0);
  }),
);
