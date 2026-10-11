// Tests inspect opaque JSON-RPC payloads at the transport boundary.
// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { openMcpHttpSession } from "./T3McpHttpSession.ts";

const error = (cause: unknown) => ({ _tag: "TestMcpError" as const, cause });

describe("MCP HTTP sessions", () => {
  it.effect.each(["http-denied", "rpc-denied", "mismatched-id", "missing-response"] as const)(
    "fails closed on %s and never replays the tool call",
    (reason) =>
      Effect.gen(function* () {
        let calls = 0;
        const session = yield* openMcpHttpSession(
          {
            endpoint: "http://127.0.0.1:1/mcp",
            authorization: "Bearer synthetic",
            fetchImplementation: async (_url, init) => {
              const request = JSON.parse(String(init?.body)) as { id: string; method: string };
              if (request.method === "notifications/initialized")
                return new Response(null, { status: 202 });
              if (request.method === "initialize")
                return Response.json({ id: request.id, result: { protocolVersion: "2025-06-18" } });
              calls++;
              if (reason === "http-denied") return new Response("denied", { status: 403 });
              if (reason === "missing-response") return new Response(null, { status: 204 });
              return Response.json(
                reason === "rpc-denied"
                  ? {
                      id: request.id,
                      error: { code: -32001, message: "private payload must not escape" },
                    }
                  : { id: "other-request", result: {} },
              );
            },
          },
          error,
        );
        const failure = yield* session
          .request("tools/call", { name: "t3_goal_update", arguments: {} })
          .pipe(Effect.asVoid, Effect.flip);
        expect(failure._tag).toBe("TestMcpError");
        expect(String(failure.cause)).not.toContain("private payload");
        expect(calls).toBe(1);
      }),
  );
  it.effect("negotiates session headers and reads SSE results", () =>
    Effect.gen(function* () {
      const headers: Headers[] = [];
      const session = yield* openMcpHttpSession(
        {
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer synthetic",
          fetchImplementation: async (_url, init) => {
            headers.push(new Headers(init?.headers));
            const request = JSON.parse(String(init?.body)) as { id: string; method: string };
            if (request.method === "notifications/initialized")
              return new Response(null, { status: 202 });
            const result =
              request.method === "initialize"
                ? { protocolVersion: "2025-03-26" }
                : { content: [{ type: "text", text: "accepted" }] };
            return new Response(
              `event: message\ndata: ${JSON.stringify({ id: request.id, result })}\n\n`,
              {
                headers: {
                  "content-type": "text/event-stream",
                  "mcp-session-id": "synthetic-session",
                },
              },
            );
          },
        },
        error,
      );
      expect(
        yield* session.request("tools/call", { name: "t3_goal_update", arguments: {} }),
      ).toEqual({ content: [{ type: "text", text: "accepted" }] });
      expect(headers[1]?.get("mcp-session-id")).toBe("synthetic-session");
      expect(headers[2]?.get("mcp-protocol-version")).toBe("2025-03-26");
    }),
  );
});
