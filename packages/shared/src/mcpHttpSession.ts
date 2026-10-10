// MCP sessions relay opaque JSON-RPC rather than decoding provider payloads.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "./mcpResponsePayloads.ts";

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}
const asEnvelope = (value: unknown): JsonRpcEnvelope | null =>
  typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpHttpSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface McpHttpSession<E> {
  /** Sends one JSON-RPC request and returns its result, failing on a JSON-RPC error. */
  readonly request: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, E>;
}

/** Opens an initialized, authenticated session on T3's streamable-HTTP MCP endpoint. */
export function openMcpHttpSession<E>(
  options: McpHttpSessionOptions,
  onError: (cause: unknown) => E,
): Effect.Effect<McpHttpSession<E>, E> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    // The bridge is single-fibered at creation time; concurrent sends only
    // read these after the sequential handshake, so plain locals suffice.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (message: unknown): Effect.Effect<ReadonlyArray<unknown>, E> =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: JSON.stringify(message),
            }),
          catch: onError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          yield* discardResponseBody(response);
          return yield* Effect.fail(
            onError(new Error(`T3 Code MCP endpoint responded with HTTP ${response.status}.`)),
          );
        }
        const payloads = yield* Stream.runCollect(responsePayloads(response, onError)).pipe(
          Effect.ensuring(discardResponseBody(response)),
        );
        for (const payload of payloads) {
          protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
        }
        return payloads;
      });

    const initializeId = "t3-acp-cli-initialize";
    const initialized = yield* send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code-acp-cli", version: "0.0.0" },
      },
    });
    const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
    if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
      return yield* Effect.fail(
        onError(new Error("T3 Code MCP endpoint rejected initialization.")),
      );
    }
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

    let nextId = 0;
    const request: McpHttpSession<E>["request"] = (method, params) =>
      Effect.gen(function* () {
        const id = `t3-mcp-request-${++nextId}`;
        const responses = yield* send({ jsonrpc: "2.0", id, method, params });
        const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
        if (envelope === null || envelope.error !== undefined) {
          return yield* Effect.fail(onError(new Error(`T3 Code MCP ${method} failed.`)));
        }
        return envelope.result;
      });
    return { request };
  });
}
