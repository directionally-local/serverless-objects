// Records one Autopilot turn from its session events (autopilot-ai's
// SessionEvent: message.*, tool.*, usage, tasks.update, warning,
// session.end): tool intents and results, usage against the run's budgets,
// and the run's end go to the run; a redacted Camouflage log goes to the
// session log. Shared by the Hotcell cell executor and the in-process run.
import { redactDeep } from "./redact.js";

const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 2_000;

export class TurnRecorder {
  #run;
  #state;
  #finish;
  #abort;
  #onEnd;
  #reasonPrefix;

  // run: the RunHost. state: { get() -> { pending, openStreams }, set(partial) },
  // persisted by the caller. finish(status, reason), abort() and onEnd() are
  // the caller's. reasonPrefix names the source in stop reasons ("cell").
  constructor({ run, state, finish, abort, onEnd = () => {}, reasonPrefix }) {
    this.#run = run;
    this.#state = state;
    this.#finish = finish;
    this.#abort = abort;
    this.#onEnd = onEnd;
    this.#reasonPrefix = reasonPrefix;
  }

  // Returns true once the turn has ended.
  async apply(event) {
    // Keep the log in order: text buffered before a tool call or usage update goes first.
    if (event?.type !== "message.delta" && event?.type !== "message.reasoning" && event?.type !== "message.end") this.flushText();
    switch (event?.type) {
      case "message.start":
        if (event.role === "assistant") {
          this.log("AssistantStreamStarted", { stream_id: event.messageId });
          this.#state.set({ openStreams: [...this.#state.get().openStreams, event.messageId] });
        }
        return false;
      case "message.delta":
        if (typeof event.text === "string") this.#bufferText("AssistantTokenDelta", event.messageId, event.text);
        return false;
      case "message.reasoning":
        if (typeof event.text === "string") this.#bufferText("AssistantReasoningDelta", event.messageId, event.text);
        return false;
      case "message.end": {
        // Only assistant streams were started; user messages end without a stream.
        this.flushText(event.messageId);
        const open = this.#state.get().openStreams;
        if (!open.includes(event.messageId)) return false;
        this.log("AssistantMessageCompleted", { stream_id: event.messageId });
        this.#state.set({ openStreams: open.filter((id) => id !== event.messageId) });
        return false;
      }
      case "tool.start":
        this.log("ToolExecutionStarted", { tool_id: event.toolCallId, tool: event.toolName, command: summarize(event.args) });
        if (this.#run.get()?.status === "running") {
          try {
            await this.#run.recordToolIntent(event.toolCallId, event.toolName, event.args);
          } catch (error) {
            if (error?.reason !== "max_tool_iterations_exceeded") throw error;
            await this.#abort();
          }
        }
        return false;
      case "tool.result": {
        const output = typeof event.result === "string" ? event.result : "";
        this.log("ToolExecutionFinished", { tool_id: event.toolCallId, exit_code: event.isError ? 1 : 0, output: bounded(output, MAX_TOOL_OUTPUT_CHARS) });
        if (this.#run.get()?.status === "running") {
          await this.#run.recordToolResult(event.toolCallId, event.toolName, { ok: !event.isError, content: output });
        }
        return false;
      }
      case "usage": {
        if (this.#run.get()?.status !== "running") return false;
        const cost = finiteOrUndefined(event.cost);
        const { run, budgetExceededReason } = await this.#run.recordUsage({
          promptTokens: wholeTokens(event.inputTokens),
          completionTokens: wholeTokens(event.outputTokens),
          ...(cost === undefined ? {} : { costUsd: cost }),
        });
        this.log("StatusUpdate", { segments: { tokens: String(run.totalPromptTokens + run.totalCompletionTokens), cost: `$${run.totalCostUsd.toFixed(4)}` } });
        if (budgetExceededReason) await this.#abort();
        return false;
      }
      case "tasks.update": {
        const todos = Array.isArray(event.tasks)
          ? event.tasks.filter((task) => typeof task?.title === "string").map((task, index) => ({
            id: String(task.id ?? index),
            title: task.title,
            status: task.status === "completed" ? "completed" : task.status === "in_progress" ? "in_progress" : "pending",
          }))
          : [];
        this.log("TodoListUpdate", { todos });
        return false;
      }
      case "warning":
        if (typeof event.message === "string") this.log("ShowToast", { text: bounded(event.message, 500), kind: "warning" });
        return false;
      case "session.end": {
        this.flushText();
        this.#onEnd();
        if (event.reason === "error") this.log("RuntimeError", { message: bounded(String(event.error ?? "error"), 500) });
        const status = event.reason === "complete" ? "completed" : event.reason === "aborted" ? "cancelled" : "failed";
        const reason = event.reason === "error" ? bounded(String(event.error ?? "error"), 500) : `${this.#reasonPrefix}_session_${event.reason}`;
        await this.#finish(status, reason);
        return true;
      }
      default:
        return false;
    }
  }

  // Session events are readable by anyone with the stream; redact likely secrets.
  log(eventType, payload) {
    this.#run.appendSessionEvents([{ event_type: eventType, payload: redactDeep(payload) }]);
  }

  flushText(streamId) {
    const { pending } = this.#state.get();
    const rest = { ...pending };
    for (const [key, text] of Object.entries(pending)) {
      const [eventType, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (streamId !== undefined && id !== streamId) continue;
      if (text) this.log(eventType, { stream_id: id, token: text });
      delete rest[key];
    }
    this.#state.set({ pending: rest });
  }

  // Streamed text is logged a line at a time (a PEM block at once) so that a
  // secret split across deltas is still whole when it is redacted.
  #bufferText(eventType, streamId, text) {
    const pending = { ...this.#state.get().pending };
    const key = `${eventType}:${streamId}`;
    const buffered = (pending[key] ?? "") + text;
    let cut = buffered.lastIndexOf("\n") + 1;
    const begin = buffered.lastIndexOf("-----BEGIN");
    if (begin !== -1) {
      const end = /-----END [A-Z ]*-----/.exec(buffered.slice(begin));
      if (!end) cut = Math.min(cut, begin);
      else if (cut > begin && cut < begin + end.index + end[0].length) cut = begin + end.index + end[0].length;
    }
    if (cut > 0) this.log(eventType, { stream_id: streamId, token: buffered.slice(0, cut) });
    pending[key] = buffered.slice(Math.max(cut, 0));
    if (!pending[key]) delete pending[key];
    this.#state.set({ pending });
  }
}

export function summarize(args) {
  if (typeof args === "string") return bounded(args, MAX_TOOL_INPUT_CHARS);
  if (args && typeof args === "object") {
    for (const key of ["command", "path", "file_path", "pattern", "url", "query"]) {
      if (typeof args[key] === "string") return bounded(args[key], MAX_TOOL_INPUT_CHARS);
    }
  }
  try {
    return bounded(JSON.stringify(args) ?? "", MAX_TOOL_INPUT_CHARS);
  } catch {
    return "";
  }
}

export function bounded(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function wholeTokens(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function finiteOrUndefined(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
