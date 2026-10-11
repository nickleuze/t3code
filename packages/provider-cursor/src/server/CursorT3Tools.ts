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
import { TrimmedNonEmptyString, type OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { openMcpHttpSession, type McpHttpSessionOptions } from "./T3McpHttpSession.ts";
class CursorT3ToolsError extends Schema.TaggedError<CursorT3ToolsError>()("CursorT3ToolsError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "T3 Code tools could not be reached.";
  }
}
const openSession = (options: McpHttpSessionOptions) =>
  openMcpHttpSession(options, (cause) => new CursorT3ToolsError({ cause }));

/** Cursor reports SDK custom tools under this MCP provider identifier. */
export const CURSOR_CUSTOM_TOOLS_PROVIDER = "custom-user-tools";

interface T3McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, SDKJsonValue>;
  readonly annotations?: SDKToolAnnotations;
  readonly outputSchema?: Record<string, SDKJsonValue>;
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
  const outputSchema = record(tool.outputSchema);
  const picked =
    annotations === undefined
      ? undefined
      : Object.fromEntries(
          ANNOTATION_KEYS.flatMap((key) =>
            typeof annotations[key] === (key === "title" ? "string" : "boolean")
              ? [[key, annotations[key]]]
              : [],
          ),
        );
  return {
    name: tool.name,
    ...(typeof tool.description === "string" ? { description: tool.description } : {}),
    ...(inputSchema === undefined
      ? {}
      : { inputSchema: inputSchema as Record<string, SDKJsonValue> }),
    ...(outputSchema === undefined
      ? {}
      : { outputSchema: outputSchema as Record<string, SDKJsonValue> }),
    ...(picked === undefined || Object.keys(picked).length === 0
      ? {}
      : { annotations: picked as SDKToolAnnotations }),
  };
}

/** Lists every tool the thread's MCP credential can see. */
export const listT3McpTools = (options: McpHttpSessionOptions) =>
  Effect.gen(function* () {
    const session = yield* openSession(options);
    const tools: Array<T3McpToolDescriptor> = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = record(
        yield* session.request("tools/list", cursor === undefined ? {} : { cursor }),
      );
      for (const entry of Array.isArray(page?.tools) ? page.tools : []) {
        const descriptor = toDescriptor(entry);
        if (descriptor !== undefined) tools.push(descriptor);
      }
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor !== undefined) {
        if (seen.has(cursor))
          return yield* new CursorT3ToolsError({ cause: new Error("Repeated MCP cursor.") });
        seen.add(cursor);
      }
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
function toCustomToolResult(value: unknown): SDKCustomToolResult {
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
 * SDK callback adapter. Every call reads the current thread credential and
 * still passes through the server's tool authorization. Cancellation closes
 * this registration; a later turn receives a new one.
 */
export function makeCursorT3CustomTools(
  tools: ReadonlyArray<T3McpToolDescriptor>,
  connection: Effect.Effect<McpHttpSessionOptions | undefined>,
) {
  const pending = new Set<AbortController>();
  let closed = false;
  const call = (name: string, args: Record<string, SDKJsonValue>) =>
    Effect.gen(function* () {
      const options = yield* connection;
      if (closed || options === undefined) {
        return toCustomToolResult({
          isError: true,
          content: [
            { type: "text", text: "T3 Code tools are no longer available to this thread." },
          ],
        });
      }
      const session = yield* openSession(options);
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
  const customTools = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        execute: async (args) => {
          const controller = new AbortController();
          pending.add(controller);
          try {
            return await Effect.runPromise(call(tool.name, args), { signal: controller.signal });
          } catch {
            return toCustomToolResult({
              isError: true,
              content: [{ type: "text", text: "T3 Code tool call was cancelled." }],
            });
          } finally {
            pending.delete(controller);
          }
        },
      } satisfies SDKCustomTool,
    ]),
  );
  return {
    tools: customTools,
    cancel: Effect.sync(() => {
      closed = true;
      for (const controller of pending) controller.abort();
    }),
  };
}

/** Cursor's own `askQuestion` is refused in local SDK runs, so T3 offers this one. */
export const CURSOR_ASK_USER_QUESTION_TOOL = "t3_ask_user_question";

const AskUserQuestionInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      header: TrimmedNonEmptyString.check(Schema.isMaxLength(12)).annotate({
        description: "A short label, at most 12 characters.",
      }),
      question: TrimmedNonEmptyString,
      options: Schema.Array(
        Schema.Struct({
          label: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
        }),
      ).check(Schema.isMaxLength(6)),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
const decodeAskUserQuestionInput = Schema.decodeUnknownResult(AskUserQuestionInput);

/**
 * A question for the user that is answered by their next message. `ask`
 * records it on the running turn; the adapter shows it once the turn ends.
 */
export function makeCursorAskUserQuestionTool(
  ask: (
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
    toolCallId: string | undefined,
  ) => void,
): SDKCustomTool {
  return {
    description:
      "Ask the user questions in T3 Code's question picker. This returns at once: end your turn after calling it. The user's answers arrive as your next user message. Prefer making reasonable assumptions; ask only when a decision is the user's to make.",
    inputSchema: toJsonSchemaObject(AskUserQuestionInput) as Record<string, SDKJsonValue>,
    annotations: { title: "Ask the user", readOnlyHint: false, destructiveHint: false },
    execute: (args, context) => {
      const decoded = decodeAskUserQuestionInput(args);
      if (Result.isFailure(decoded)) {
        return toCustomToolResult({
          isError: true,
          content: [{ type: "text", text: `Invalid questions: ${decoded.failure.message}` }],
        });
      }
      ask(
        decoded.success.questions.map((question, index) => ({
          id: String(index + 1),
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiSelect: question.multiSelect ?? false,
          allowCustomAnswer: true,
        })),
        context.toolCallId,
      );
      return toCustomToolResult({
        content: [
          {
            type: "text",
            text: "The user will see your questions when this turn ends. End your turn now; their answers arrive as your next message.",
          },
        ],
      });
    },
  };
}
