// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listT3McpTools, makeCursorT3CustomTools } from "./CursorT3Tools.ts";

/** A fake T3 MCP endpoint answering `tools/list` in two pages and `tools/call` via `onCall`. */
function fakeEndpoint(onCall: (params: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImplementation = async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      readonly id?: unknown;
      readonly method?: string;
      readonly params?: Record<string, unknown>;
    };
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: unknown;
    switch (request.method) {
      case "initialize":
        result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} };
        break;
      case "tools/list":
        result =
          request.params?.cursor === undefined
            ? {
                tools: [
                  {
                    name: "t3_ask_user_question",
                    description: "Ask the user.",
                    inputSchema: { type: "object" },
                    annotations: { destructiveHint: false, unknownHint: true },
                  },
                ],
                nextCursor: "page-2",
              }
            : { tools: [{ name: "orchestrator_capabilities", inputSchema: { type: "object" } }] };
        break;
      case "tools/call":
        calls.push(request.params ?? {});
        result = onCall(request.params ?? {});
        break;
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  const connection = {
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer cursor-test",
    fetchImplementation,
  };
  return { connection, calls };
}

describe("Cursor T3 custom tools", () => {
  it.effect("lists every page of T3 tools with only the annotations Cursor accepts", () =>
    Effect.gen(function* () {
      const { connection } = fakeEndpoint(() => ({}));
      const tools = yield* listT3McpTools(connection);

      expect(tools).toEqual([
        {
          name: "t3_ask_user_question",
          description: "Ask the user.",
          inputSchema: { type: "object" },
          annotations: { destructiveHint: false },
        },
        { name: "orchestrator_capabilities", inputSchema: { type: "object" } },
      ]);
    }),
  );

  it.effect("forwards a call and returns T3's result, refusals included", () =>
    Effect.gen(function* () {
      const { connection, calls } = fakeEndpoint(() => ({
        isError: true,
        content: [{ type: "text", text: "This provider has its own question tool." }],
        structuredContent: { code: "invalid_request" },
      }));
      const tools = makeCursorT3CustomTools([{ name: "t3_ask_user_question" }], () => connection);

      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.t3_ask_user_question!.execute({ questions: [] }, {})),
      );

      expect(calls).toEqual([{ name: "t3_ask_user_question", arguments: { questions: [] } }]);
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "This provider has its own question tool." }],
        structuredContent: { code: "invalid_request" },
      });
    }),
  );

  it.effect("reports an unreachable endpoint or a closed credential as a tool error", () =>
    Effect.gen(function* () {
      const unreachable = makeCursorT3CustomTools([{ name: "orchestrator_capabilities" }], () => ({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer cursor-test",
        fetchImplementation: () => Promise.reject(new Error("connect ECONNREFUSED")),
      }));
      const closed = makeCursorT3CustomTools(
        [{ name: "orchestrator_capabilities" }],
        () => undefined,
      );

      const failed = yield* Effect.promise(() =>
        Promise.resolve(unreachable.orchestrator_capabilities!.execute({}, {})),
      );
      const gone = yield* Effect.promise(() =>
        Promise.resolve(closed.orchestrator_capabilities!.execute({}, {})),
      );

      expect(failed).toMatchObject({ isError: true, content: [{ text: "connect ECONNREFUSED" }] });
      expect(gone).toMatchObject({ isError: true });
    }),
  );
});
