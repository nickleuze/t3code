import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderSessionId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fake-question-model" };

const questions = [{ id: "1", header: "Choice", question: "Which approach?", options: [] }];

it.effect.each([
  "answer",
  "queue",
  "steer",
  "dismiss",
  "stop",
  "restart",
  "native",
  "delegated",
  "stale",
] as const)("durable fallback question with a fake provider: %s", (outcome) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`question-runtime-${outcome}`);
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        planning: {
          ...CodexProviderCapabilitiesV2.planning,
          supportsStructuredQuestions: outcome === "native",
        },
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: outcome === "steer",
        },
      };
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steered: string[] = [];
      const secondStarted = yield* Deferred.make<void>();
      let finish: Effect.Effect<unknown> = Effect.die("No live turn");
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            let current: ProviderAdapter.ProviderAdapterV2TurnInput;
            const turnId = () => ProviderTurnId.make(`fake-turn:${current.attemptId}`);
            const terminal = (status: "completed" | "interrupted") =>
              Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: current.providerThread.id,
                providerTurnId: turnId(),
                runOrdinal: current.runOrdinal,
                status,
                failure: null,
                threadDisposition: "reusable",
              });
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`fake-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  current = turn;
                  started.push(turn);
                  if (started.length === 2) yield* Deferred.succeed(secondStarted, undefined);
                  finish = terminal("completed");
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: turnId(),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: { driver, nativeId: "turn", strength: "strong" },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (input) =>
                Effect.sync(() => {
                  steered.push(input.message.text);
                }),
              interruptTurn: () =>
                Effect.gen(function* () {
                  yield* terminal("interrupted");
                }),
              respondToRuntimeRequest: () =>
                Effect.die("Fallback answers must be messages, never permission responses"),
              readThreadSnapshot: () => Effect.die("Unexpected snapshot in goal runtime test"),
              rollbackThread: () => Effect.die("Unexpected rollback in goal runtime test"),
              forkThread: () => Effect.die("Unexpected fork in goal runtime test"),
            };
          }),
      };
      const database = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient);
      const threadId = ThreadId.make(`question:${outcome}`);
      const requestId = RuntimeRequestId.make(`question:${outcome}:request`);
      const runtime = (recoverOnStartup = false) =>
        Layer.mergeAll(
          ProviderReplayHarness.layerWithRegistry(
            { name: `question-runtime-${outcome}` },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            { databaseLayer: database, recoverOnStartup, continueThreadsAfterServerUpdate: false },
          ),
          ProjectionStore.layer.pipe(Layer.provide(database)),
        );
      const answer = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("answer"),
        threadId,
        requestId,
        answers: { "1": "  Minimal port  " },
      };
      const verifyAnswer = Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const invalid = yield* orchestrator
          .dispatch({ ...answer, commandId: CommandId.make("blank"), answers: { "1": " " } })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]?.status,
          "pending",
        );
        const accepted = yield* orchestrator.dispatch(answer);
        assert.equal((yield* orchestrator.dispatch(answer)).sequence, accepted.sequence);
        yield* worker.drain();
        if (outcome === "queue") {
          assert.lengthOf(started, 1);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "queued",
          );
          yield* finish;
        }
        if (outcome !== "steer") {
          yield* Deferred.await(secondStarted);
          const sink = yield* EventSink.EventSinkV2;
          const next = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* sink.stream().pipe(
            Stream.filter(
              ({ event }) =>
                event.threadId === threadId &&
                event.type === "run.updated" &&
                event.payload.id === next.id &&
                event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain();
        }
        const p = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(p.runtimeRequests[0]?.status, "resolved");
        assert.deepEqual(
          p.messages.filter((m) => m.id === `async-answer:${requestId}`).map((m) => m.text),
          ["Which approach?\nMinimal port"],
        );
        const item = p.turnItems.find((item) => item.type === "user_input_request");
        assert.equal(item?.status, "completed");
        assert.equal(
          item?.type === "user_input_request" ? item.questionAnswer?.answers["1"] : undefined,
          "  Minimal port  ",
        );
        assert.lengthOf(started, outcome === "steer" ? 1 : 2);
        assert.deepEqual(steered, outcome === "steer" ? ["Which approach?\nMinimal port"] : []);
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const wait = (id: ThreadId) =>
            sink.stream().pipe(
              Stream.filter(
                ({ event }) =>
                  event.threadId === id &&
                  event.type === "provider-turn.updated" &&
                  event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("questions"),
            title: "Question test",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start"),
            threadId,
            messageId: MessageId.make("initial"),
            text: "Ask a question",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* wait(threadId);
          let target = threadId;
          if (outcome === "delegated") {
            const parent = yield* orchestrator.getThreadProjection(threadId);
            yield* orchestrator.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make("delegate"),
              parentThreadId: threadId,
              parentRunId: parent.runs[0]!.id,
              parentNodeId: parent.runs[0]!.rootNodeId!,
              task: "Ask as a child",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            });
            target = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!
              .childThreadId!;
            yield* worker.drain();
            yield* wait(target);
          }
          const p = yield* orchestrator.getThreadProjection(target);
          const run = p.runs.at(-1)!;
          const sessionId = p.providerThreads.find(
            (t) => t.id === run.providerThreadId,
          )!.providerSessionId!;
          const command = {
            type: "thread.user-input.request" as const,
            commandId: CommandId.make("ask"),
            threadId: target,
            runId: run.id,
            providerSessionId: sessionId,
            requestId,
            questions,
          };
          if (outcome === "native" || outcome === "delegated" || outcome === "stale") {
            const refusal = yield* orchestrator
              .dispatch(
                outcome === "stale"
                  ? { ...command, providerSessionId: ProviderSessionId.make("retired") }
                  : command,
              )
              .pipe(Effect.result);
            assert.equal(refusal._tag, "Failure");
            assert.lengthOf((yield* orchestrator.getThreadProjection(target)).runtimeRequests, 0);
            if (outcome === "stale") {
              assert.equal(
                (yield* orchestrator
                  .dispatch({
                    ...command,
                    commandId: CommandId.make("old-run"),
                    runId: RunId.make("old"),
                  })
                  .pipe(Effect.result))._tag,
                "Failure",
              );
            }
            return;
          }
          const accepted = yield* orchestrator.dispatch(command);
          assert.equal((yield* orchestrator.dispatch(command)).sequence, accepted.sequence);
          assert.equal(
            (yield* orchestrator
              .dispatch({ ...command, commandId: CommandId.make("duplicate-request") })
              .pipe(Effect.result))._tag,
            "Failure",
          );
          const asked = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(asked.runtimeRequests, 1);
          assert.deepEqual(asked.runtimeRequests[0]?.responseCapability, { type: "message" });
          assert.deepEqual(
            asked.turnItems
              .filter((i) => i.type === "user_input_request")
              .map((i) => i.type === "user_input_request" && i.questions),
            [questions],
          );
          assert.equal(
            asked.nodes.find((n) => n.runtimeRequestId === requestId)?.countsForRun,
            false,
          );
          if (outcome === "restart") return;
          if (outcome === "answer") {
            yield* finish;
            yield* sink.stream().pipe(
              Stream.filter(
                ({ event }) =>
                  event.threadId === threadId &&
                  event.type === "run.updated" &&
                  event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            yield* worker.drain();
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]?.status,
              "pending",
            );
          }
          if (outcome === "answer" || outcome === "queue" || outcome === "steer") {
            yield* verifyAnswer;
            return;
          }
          yield* orchestrator.dispatch(
            outcome === "dismiss"
              ? {
                  type: "thread.user-input.dismiss",
                  commandId: CommandId.make("dismiss"),
                  threadId,
                  requestId,
                }
              : { type: "thread.stop", commandId: CommandId.make("stop"), threadId },
          );
          yield* worker.drain();
          const ended = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            ended.runtimeRequests[0]?.status,
            outcome === "dismiss" ? "resolved" : "cancelled",
          );
          assert.equal(
            ended.nodes.find((n) => n.runtimeRequestId === requestId)?.status,
            "cancelled",
          );
          assert.lengthOf(ended.messages, 1);
          assert.lengthOf(started, 1);
        }).pipe(Effect.provide(runtime())),
      );
      if (outcome === "restart")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const p = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(p.runtimeRequests[0]?.status, "pending");
            assert.isTrue(
              p.runs.every((run) => !["running", "waiting", "starting"].includes(run.status)),
            );
            assert.lengthOf(started, 1);
            yield* verifyAnswer;
          }).pipe(Effect.provide(runtime(true))),
        );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  ),
);
