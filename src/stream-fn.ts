/**
 * M1 — a `StreamFn` for the browser: OpenAI-compatible chat completions over
 * plain `fetch`, with **no SDK**.
 *
 * ## Why not reuse `pi-ai`'s `streamSimple`
 *
 * It satisfies the same type, so the temptation is obvious. Measured on the
 * installed tree (2026-08-10) rather than assumed:
 *
 * - `pi-ai` depends on **five provider SDKs** — `openai`, `@anthropic-ai/sdk`,
 *   `@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@mistralai/mistralai`
 *   — of which the first three alone are ~30 MB on disk. A browser compartment
 *   that ships a provider catalog to talk to one endpoint has already lost the
 *   bundle argument G0 was gated on.
 * - It also depends on `http-proxy-agent` / `https-proxy-agent` and
 *   `@smithy/node-http-handler`, which are **Node-only** transports.
 * - The `openai` SDK sends `x-stainless-retry-count`, a custom request header.
 *   Custom headers force a CORS **preflight**, and the preflight fails unless
 *   the server echoes that exact name in `Access-Control-Allow-Headers`. Our
 *   platform proxy has no reason to allowlist a header from an SDK we do not
 *   otherwise use — so the SDK would fail against our own endpoint, in the
 *   browser only, for a reason that looks nothing like its cause.
 *
 * That last point is why the plan put `StreamFn` first: it is the cheapest
 * place to discover the CORS constraint M6 would otherwise hit at cutover.
 *
 * ## What this sends
 *
 * Two headers: `content-type` and `authorization`. Both are on the CORS
 * safelist or universally allowed, so **this never triggers a preflight** for
 * a simple POST. Adding a third header here is not a small change — it turns
 * every request into two and makes the endpoint's CORS configuration part of
 * our contract.
 *
 * ## The error contract
 *
 * `StreamFn` must **not throw and must not reject**. A transport failure, a
 * non-2xx response, an abort, malformed SSE — all of it is encoded *into the
 * stream* as an `error` event whose message carries `stopReason: "error"` or
 * `"aborted"`. A rejected promise here would surface inside the agent loop as
 * an unhandled failure rather than as a turn the agent can see and report.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
// The class and a type of the same name are both re-exported, and the type
// wins at the package root -- so the documented factory ("for use in
// extensions") is the value-level way in.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as unknown as Usage;

export interface BrowserStreamOptions {
  /**
   * Where to POST. The **platform proxy** in our deployment, not a provider:
   * the shared platform key must never reach a browser, so the browser talks
   * to something that holds the key on its behalf.
   */
  baseUrl: string;
  /**
   * Optional bearer. Absent for the keyless platform proxy, which authorises
   * by session cookie — the arrangement that lets a compartment run with zero
   * credentials of its own.
   */
  apiKey?: string;
  /** Model id sent verbatim; the endpoint owns the catalog, not us. */
  model: string;
  fetchImpl?: typeof fetch;
}

function baseMessage(model: string, stopReason: StopReason): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions" as Api,
    provider: "openai" as AssistantMessage["provider"],
    model,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/** Map pi's message shapes onto the wire format. */
function toWireMessages(context: Context): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (context.systemPrompt) out.push({ role: "system", content: context.systemPrompt });
  for (const message of (context.messages ?? []) as Message[]) {
    if (message.role === "user") {
      const text = Array.isArray(message.content)
        ? message.content
            .filter((part): part is TextContent => (part as TextContent).type === "text")
            .map((part) => part.text)
            .join("")
        : String(message.content ?? "");
      out.push({ role: "user", content: text });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      const toolCalls = message.content.filter(
        (part): part is ToolCall => part.type === "toolCall",
      );
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
    }
  }
  return out;
}

function toWireTools(context: Context): Array<Record<string, unknown>> | undefined {
  const tools = context.tools ?? [];
  if (!tools.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Split an SSE body into `data:` payloads.
 *
 * Written out rather than pulled in: an SSE frame is delimited by a blank
 * line, and a chunk boundary can fall anywhere — including mid-frame — so the
 * buffer must persist across reads. Getting this wrong drops the last token of
 * a response often enough to look like a model quirk.
 */
async function* sseData(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function createBrowserStreamFn(options: BrowserStreamOptions): StreamFn {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return (_model: Model<Api>, context: Context, streamOptions?: { signal?: AbortSignal }) => {
    const stream = createAssistantMessageEventStream();

    const fail = (reason: "error" | "aborted", message: string) => {
      const error = baseMessage(options.model, reason);
      error.errorMessage = message;
      stream.push({ type: "error", reason, error });
      stream.end(error);
    };

    void (async () => {
      const partial = baseMessage(options.model, "stop");
      try {
        const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          // Exactly two headers, both preflight-free. See the module comment.
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: options.model,
            stream: true,
            messages: toWireMessages(context),
            ...(toWireTools(context) ? { tools: toWireTools(context) } : {}),
          }),
          signal: streamOptions?.signal,
        });

        if (!response.ok) {
          // The body usually says more than the status; include it, bounded.
          const detail = (await response.text().catch(() => "")).slice(0, 500);
          fail("error", `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
          return;
        }

        stream.push({ type: "start", partial });
        let text = "";
        let textOpen = false;
        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let stopReason: Extract<StopReason, "stop" | "length" | "toolUse"> = "stop";

        for await (const data of sseData(response)) {
          if (data === "[DONE]") break;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            // A malformed frame is not worth failing a whole turn over; the
            // stream is a best-effort transport and the next frame usually
            // carries on.
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === "string" && delta.content.length) {
            if (!textOpen) {
              textOpen = true;
              partial.content.push({ type: "text", text: "" } as TextContent);
              stream.push({ type: "text_start", contentIndex: 0, partial });
            }
            text += delta.content;
            (partial.content[0] as TextContent).text = text;
            stream.push({ type: "text_delta", contentIndex: 0, delta: delta.content, partial });
          }

          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const existing = toolCalls.get(index) ?? { id: call.id ?? "", name: "", args: "" };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments) existing.args += call.function.arguments;
            toolCalls.set(index, existing);
          }

          if (choice.finish_reason === "length") stopReason = "length";
          else if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
        }

        if (textOpen) {
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        }

        for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          const contentIndex = partial.content.length;
          let args: unknown = {};
          try {
            args = call.args ? JSON.parse(call.args) : {};
          } catch {
            // Arguments that do not parse are the model's error, not the
            // transport's: surface the raw string so the tool layer can
            // reject it with something a reader can act on, rather than
            // silently calling the tool with `{}`.
            args = { __unparsed: call.args };
          }
          const toolCall = {
            type: "toolCall",
            id: call.id || `call_${index}`,
            name: call.name,
            arguments: args,
          } as unknown as ToolCall;
          partial.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
          stopReason = "toolUse";
        }

        partial.stopReason = stopReason;
        stream.push({ type: "done", reason: stopReason, message: partial });
        stream.end(partial);
      } catch (err) {
        const aborted =
          (err as { name?: string })?.name === "AbortError" || streamOptions?.signal?.aborted;
        fail(aborted ? "aborted" : "error", (err as Error)?.message ?? String(err));
      }
    })();

    return stream;
  };
}
