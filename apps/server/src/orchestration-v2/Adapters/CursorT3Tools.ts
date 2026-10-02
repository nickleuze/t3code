/**
 * T3's MCP tools as Cursor SDK custom tools.
 *
 * Local Cursor runs fail MCP server calls closed whenever the sandbox or
 * Auto-review is on, because the SDK has no approval callback for them. SDK
 * custom tools are in-process callbacks that never need approval, so each
 * T3 tool is registered as one that forwards to the thread's authenticated
 * MCP endpoint. T3's server still applies its own capability checks.
 */
import type {
  SDKCustomTool,
  SDKCustomToolContent,
  SDKCustomToolResult,
  SDKJsonValue,
  SDKToolAnnotations,
} from "@cursor/sdk";
import * as Effect from "effect/Effect";

import { openT3McpHttpSession, type T3McpHttpSessionOptions } from "../../mcp/AcpMcpStdioBridge.ts";

/** Cursor reports SDK custom tools under this MCP provider identifier. */
export const CURSOR_CUSTOM_TOOLS_PROVIDER = "custom-user-tools";

export interface T3McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, SDKJsonValue>;
  readonly annotations?: SDKToolAnnotations;
}

const ANNOTATION_KEYS = [
  "title",
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function toDescriptor(value: unknown): T3McpToolDescriptor | undefined {
  const tool = record(value);
  if (typeof tool?.name !== "string") return undefined;
  const inputSchema = record(tool.inputSchema);
  const annotations = record(tool.annotations);
  const picked =
    annotations === undefined
      ? undefined
      : Object.fromEntries(
          ANNOTATION_KEYS.flatMap((key) =>
            annotations[key] === undefined ? [] : [[key, annotations[key]]],
          ),
        );
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(inputSchema === undefined
      ? {}
      : { inputSchema: inputSchema as Record<string, SDKJsonValue> }),
    ...(picked === undefined || Object.keys(picked).length === 0
      ? {}
      : { annotations: picked as SDKToolAnnotations }),
  };
}

/** Lists every tool the thread's MCP credential can see. */
export const listT3McpTools = (options: T3McpHttpSessionOptions) =>
  Effect.gen(function* () {
    const session = yield* openT3McpHttpSession(options);
    const tools: Array<T3McpToolDescriptor> = [];
    let cursor: string | undefined;
    do {
      const page = record(
        yield* session.request("tools/list", cursor === undefined ? {} : { cursor }),
      );
      for (const entry of Array.isArray(page?.tools) ? page.tools : []) {
        const descriptor = toDescriptor(entry);
        if (descriptor !== undefined) tools.push(descriptor);
      }
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  });

function toContent(value: unknown): SDKCustomToolContent {
  const item = record(value);
  if (item?.type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }
  if (item?.type === "image" && typeof item.data === "string") {
    return {
      type: "image",
      data: item.data,
      ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    };
  }
  return { type: "text", text: JSON.stringify(value) };
}

/** An MCP `tools/call` result in the shape Cursor accepts from a custom tool. */
export function toCustomToolResult(value: unknown): SDKCustomToolResult {
  const result = record(value);
  const structuredContent = record(result?.structuredContent);
  return {
    content: (Array.isArray(result?.content) ? result.content : []).map(toContent),
    ...(result?.isError === true ? { isError: true } : {}),
    ...(structuredContent === undefined
      ? {}
      : { structuredContent: structuredContent as Record<string, SDKJsonValue> }),
  };
}

/**
 * Custom tools that forward to T3's MCP server. `connection` is read on every
 * call so a refreshed thread credential is used without reopening the agent.
 */
export function makeCursorT3CustomTools(
  tools: ReadonlyArray<T3McpToolDescriptor>,
  connection: () => T3McpHttpSessionOptions | undefined,
): Record<string, SDKCustomTool> {
  const call = (name: string, args: Record<string, SDKJsonValue>) =>
    Effect.gen(function* () {
      const options = connection();
      if (options === undefined) {
        return toCustomToolResult({
          isError: true,
          content: [
            { type: "text", text: "T3 Code tools are no longer available to this thread." },
          ],
        });
      }
      const session = yield* openT3McpHttpSession(options);
      return toCustomToolResult(yield* session.request("tools/call", { name, arguments: args }));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          toCustomToolResult({
            isError: true,
            content: [{ type: "text", text: error.message }],
          }),
        ),
      ),
    );
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        execute: (args) => Effect.runPromise(call(tool.name, args)),
      } satisfies SDKCustomTool,
    ]),
  );
}
