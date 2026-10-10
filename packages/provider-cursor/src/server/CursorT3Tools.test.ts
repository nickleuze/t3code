// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

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
                    annotations: {
                      destructiveHint: false,
                      unknownHint: true,
                      readOnlyHint: "wrong-type",
                    },
                    outputSchema: { type: "object" },
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
          outputSchema: { type: "object" },
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
      const { tools } = makeCursorT3CustomTools(
        [{ name: "t3_ask_user_question" }],
        Effect.succeed(connection),
      );

      const result = yield* Effect.promise(() =>
        Promise.resolve(tools.t3_ask_user_question!.execute({ questions: [] })),
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
      const unreachable = makeCursorT3CustomTools(
        [{ name: "orchestrator_capabilities" }],
        Effect.succeed({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer cursor-test",
          fetchImplementation: () => Promise.reject(new Error("connect ECONNREFUSED")),
        }),
      );
      const closed = makeCursorT3CustomTools(
        [{ name: "orchestrator_capabilities" }],
        Effect.succeed(undefined),
      );

      const failed = yield* Effect.promise(() =>
        Promise.resolve(unreachable.tools.orchestrator_capabilities!.execute({})),
      );
      const gone = yield* Effect.promise(() =>
        Promise.resolve(closed.tools.orchestrator_capabilities!.execute({})),
      );

      expect(failed).toMatchObject({
        isError: true,
        content: [{ text: "T3 Code tools could not be reached." }],
      });
      expect(gone).toMatchObject({ isError: true });
    }),
  );
  it.effect("reads refreshed credentials and closes a registration after cancellation", () =>
    Effect.gen(function* () {
      const { connection, calls } = fakeEndpoint(() => ({
        content: [{ type: "text", text: "done" }],
      }));
      const credentials: string[] = [];
      const current = yield* Ref.make<typeof connection | undefined>(connection);
      const read = Ref.get(current).pipe(
        Effect.map((value) =>
          value === undefined
            ? undefined
            : {
                ...value,
                fetchImplementation: async (url: string, init?: RequestInit) => {
                  credentials.push(new Headers(init?.headers).get("authorization") ?? "");
                  return value.fetchImplementation(url, init);
                },
              },
        ),
      );
      const bridge = makeCursorT3CustomTools([{ name: "orchestrator_capabilities" }], read);
      const invoke = () =>
        Effect.promise(() => Promise.resolve(bridge.tools.orchestrator_capabilities!.execute({})));
      yield* invoke();
      yield* Ref.set(current, { ...connection, authorization: "Bearer refreshed-test" });
      yield* invoke();
      expect(credentials.slice(0, 3)).toEqual(Array(3).fill("Bearer cursor-test"));
      expect(credentials.slice(3)).toEqual(Array(3).fill("Bearer refreshed-test"));
      yield* Ref.set(current, undefined);
      expect(yield* invoke()).toMatchObject({ isError: true });
      yield* Ref.set(current, connection);
      yield* bridge.cancel;
      expect(yield* invoke()).toMatchObject({ isError: true });
      expect(calls).toHaveLength(2);
    }),
  );
  it.effect("aborts an outstanding callback and does not replay its tool call", () =>
    Effect.gen(function* () {
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const base = fakeEndpoint(() => ({}));
      let calls = 0;
      let aborted = false;
      const connection = {
        ...base.connection,
        fetchImplementation: async (url: string, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as { method: string };
          if (request.method !== "tools/call")
            return base.connection.fetchImplementation(url, init);
          calls++;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
            markStarted();
          });
        },
      };
      const bridge = makeCursorT3CustomTools(
        [{ name: "orchestrator_capabilities" }],
        Effect.succeed(connection),
      );
      const pending = Promise.resolve(bridge.tools.orchestrator_capabilities!.execute({}));
      yield* Effect.promise(() => started);
      yield* bridge.cancel;
      expect(yield* Effect.promise(() => pending)).toMatchObject({ isError: true });
      expect(aborted).toBe(true);
      expect(calls).toBe(1);
    }),
  );
  it.effect("rejects repeated pagination cursors without looping", () =>
    Effect.gen(function* () {
      const base = fakeEndpoint(() => ({}));
      const connection = {
        ...base.connection,
        fetchImplementation: async (url: string, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as { id: unknown; method: string };
          return request.method === "tools/list"
            ? Response.json({ id: request.id, result: { tools: [], nextCursor: "same" } })
            : base.connection.fetchImplementation(url, init);
        },
      };
      expect(yield* listT3McpTools(connection).pipe(Effect.flip)).toMatchObject({
        _tag: "CursorT3ToolsError",
      });
    }),
  );
});
