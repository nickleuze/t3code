import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HostDeploymentError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HostDeployment from "../../../deploy/HostDeployment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as DeploymentHandlers from "./handlers.ts";
import { DeploymentToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:acceptance");

it.effect("an agent's acceptance receipt is refused until the install is verified", () =>
  Effect.gen(function* () {
    const toolkit = yield* DeploymentToolkit;
    const result = yield* toolkit
      .handle("t3_deployment_record_acceptance", {
        releaseId: "0.0.46-nick.22",
        scope: "Project creation works",
        summary: "Created a project.",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: "Acceptance needs a verified install; 0.0.46-nick.22 is waiting.",
    });
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(DeploymentHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:mini"),
              requestNamespace: "provider:acceptance",
              thread: {
                threadId,
                providerSessionId: "provider:acceptance",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
            Layer.mock(HostDeployment.HostDeployment)({
              recordAcceptance: (input) =>
                Effect.fail(
                  new HostDeploymentError({
                    message: `Acceptance needs a verified install; ${input.releaseId} is waiting.`,
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
  ),
);
