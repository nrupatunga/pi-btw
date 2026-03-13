import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  completeSimple,
  streamSimple,
  type AssistantMessage,
  type Message,
  type ThinkingLevel as AiThinkingLevel,
} from "@mariozechner/pi-ai";
import { Box, Text } from "@mariozechner/pi-tui";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";

const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent";

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

type BtwSlot = {
  question: string;
  modelLabel: string;
  thinking: string;
  answer: string;
  done: boolean;
  controller: AbortController;
};

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

function toReasoning(level: SessionThinkingLevel): AiThinkingLevel | undefined {
  return level === "off" ? undefined : level;
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function buildMainMessages(ctx: ExtensionCommandContext): Message[] {
  const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  return sessionContext.messages.filter((message) => !isVisibleBtwMessage(message));
}

function buildBtwContext(
  ctx: ExtensionCommandContext,
  question: string,
  thread: BtwDetails[],
  mode: BtwThreadMode,
) {
  const messages: Message[] = mode === "contextual" ? [...buildMainMessages(ctx)] : [];

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: "[The following is a separate side conversation. Continue this thread.]" }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Understood, continuing our side conversation." }],
        provider: ctx.model?.provider ?? "unknown",
        model: ctx.model?.id ?? "unknown",
        api: ctx.model?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: ctx.model?.api ?? "openai-responses",
          usage:
            entry.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  messages.push({
    role: "user",
    content: [{ type: "text", text: question }],
    timestamp: Date.now(),
  });

  return {
    systemPrompt: [ctx.getSystemPrompt(), BTW_SYSTEM_PROMPT].filter(Boolean).join("\n\n"),
    messages,
  };
}

function buildBtwMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function formatThread(thread: BtwDetails[]): string {
  return thread.map((entry) => `User: ${entry.question.trim()}\nAssistant: ${entry.answer.trim()}`).join("\n\n---\n\n");
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let slots: BtwSlot[] = [];
  let widgetStatus: string | null = null;

  function abortActiveSlots(): void {
    for (const slot of slots) {
      if (!slot.done) {
        slot.controller.abort();
      }
    }
  }

  function renderWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      return;
    }

    if (slots.length === 0) {
      ctx.ui.setWidget("btw", undefined);
      return;
    }

    ctx.ui.setWidget(
      "btw",
      (_tui, theme) => {
        const dim = (text: string) => theme.fg("dim", text);
        const success = (text: string) => theme.fg("success", text);
        const italic = (text: string) => theme.fg("dim", theme.italic(text));
        const warning = (text: string) => theme.fg("warning", text);
        const parts: string[] = [];

        const title = pendingMode === "tangent" ? " 💭 btw:tangent " : " 💭 btw ";
        const hint = " /btw:clear dismiss · /btw:inject send ";
        const width = Math.max(22, 68 - title.length - hint.length);
        parts.push(dim(`╭${title}${"─".repeat(width)}${hint}╮`));

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          if (i > 0) {
            parts.push(dim("│ ───"));
          }

          parts.push(dim("│ ") + success("› ") + slot.question);

          if (slot.thinking) {
            const cursor = !slot.answer && !slot.done ? warning(" ▍") : "";
            parts.push(dim("│ ") + italic(slot.thinking) + cursor);
          }

          if (slot.answer) {
            const answerLines = slot.answer.split("\n");
            parts.push(dim("│ ") + answerLines[0]);
            if (answerLines.length > 1) {
              parts.push(answerLines.slice(1).join("\n"));
            }
            if (!slot.done) {
              parts[parts.length - 1] += warning(" ▍");
            }
          } else if (!slot.done) {
            parts.push(dim("│ ") + warning("⏳ thinking..."));
          }

          parts.push(dim("│ ") + dim(`model: ${slot.modelLabel}`));
        }

        if (widgetStatus) {
          parts.push(dim("│ ") + warning(widgetStatus));
        }

        parts.push(dim(`╰${"─".repeat(68)}╯`));
        return new Text(parts.join("\n"), 0, 0);
      },
      { placement: "aboveEditor" },
    );
  }

  function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): void {
    abortActiveSlots();
    pendingThread = [];
    pendingMode = mode;
    slots = [];
    widgetStatus = null;
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    renderWidget(ctx);
  }

  function restoreThread(ctx: ExtensionContext): void {
    abortActiveSlots();
    pendingThread = [];
    pendingMode = "contextual";
    slots = [];
    widgetStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = branch[i].data as BtwResetDetails | undefined;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = entry.data as BtwDetails | undefined;
      if (!details?.question || !details.answer) {
        continue;
      }

      pendingThread.push(details);
      slots.push({
        question: details.question,
        modelLabel: `${details.provider}/${details.model}`,
        thinking: details.thinking || "",
        answer: details.answer,
        done: true,
        controller: new AbortController(),
      });
    }

    renderWidget(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    const model = ctx.model;
    if (!model) {
      notify(ctx, "No active model selected.", "error");
      return;
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      notify(ctx, `No credentials available for ${model.provider}/${model.id}.`, "error");
      return;
    }

    const wasBusy = !ctx.isIdle();
    pendingMode = mode;
    const thinkingLevel = pi.getThinkingLevel() as SessionThinkingLevel;
    const slot: BtwSlot = {
      question,
      modelLabel: `${model.provider}/${model.id}`,
      thinking: "",
      answer: "",
      done: false,
      controller: new AbortController(),
    };

    const threadSnapshot = pendingThread.slice();
    slots.push(slot);
    renderWidget(ctx);

    try {
      const stream = streamSimple(model, buildBtwContext(ctx, question, threadSnapshot, mode), {
        apiKey,
        reasoning: toReasoning(thinkingLevel),
        signal: slot.controller.signal,
      });

      let response: AssistantMessage | null = null;

      for await (const event of stream) {
        if (event.type === "thinking_delta") {
          slot.thinking += event.delta;
          renderWidget(ctx);
        } else if (event.type === "text_delta") {
          slot.answer += event.delta;
          renderWidget(ctx);
        } else if (event.type === "done") {
          response = event.message;
        } else if (event.type === "error") {
          response = event.error;
        }
      }

      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        const slotIndex = slots.indexOf(slot);
        if (slotIndex >= 0) {
          slots.splice(slotIndex, 1);
          renderWidget(ctx);
        }
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || slot.thinking;
      slot.thinking = thinking;
      slot.answer = answer;
      slot.done = true;
      renderWidget(ctx);

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested, wasBusy);
      if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
      }
    } catch (error) {
      if (slot.controller.signal.aborted) {
        const slotIndex = slots.indexOf(slot);
        if (slotIndex >= 0) {
          slots.splice(slotIndex, 1);
          renderWidget(ctx);
        }
        return;
      }

      slot.answer = `❌ ${error instanceof Error ? error.message : String(error)}`;
      slot.done = true;
      renderWidget(ctx);
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: BtwDetails[]): Promise<string> {
    const model = ctx.model;
    if (!model) {
      throw new Error("No active model selected.");
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      throw new Error(`No credentials available for ${model.provider}/${model.id}.`);
    }

    const response = await completeSimple(
      model,
      {
        systemPrompt: "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: formatThread(thread) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        reasoning: "low",
      },
    );

    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
    }
    if (response.stopReason === "aborted") {
      throw new Error("BTW summarize aborted.");
    }

    return extractAnswer(response);
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text btw message]";
    const lines = [theme.fg("accent", theme.bold("[BTW]")), content];

    if (expanded && details) {
      lines.push(
        theme.fg("dim", `model: ${details.provider}/${details.model} · thinking: ${details.thinkingLevel}`),
      );

      if (details.usage) {
        lines.push(
          theme.fg(
            "dim",
            `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
          ),
        );
      }
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreThread(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    abortActiveSlots();
  });

  pi.registerCommand("btw", {
    description: "Continue a side conversation in a widget above the editor. Add --save to also persist a visible note.",
    handler: async (args, ctx) => {
      const { question, save } = parseBtwArgs(args);
      if (!question) {
        notify(ctx, "Usage: /btw [--save] <question>", "warning");
        return;
      }

      if (pendingMode !== "contextual") {
        resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Start or continue a contextless BTW tangent that does not inherit the main session context.",
    handler: async (args, ctx) => {
      const { question, save } = parseBtwArgs(args);
      if (!question) {
        notify(ctx, "Usage: /btw:tangent [--save] <question>", "warning");
        return;
      }

      if (pendingMode !== "tangent") {
        resetThread(ctx, true, "tangent");
      }

      await runBtw(ctx, question, save, "tangent");
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
    handler: async (args, ctx) => {
      resetThread(ctx, true, "contextual");
      const { question, save } = parseBtwArgs(args);
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the BTW widget and clear the current thread.",
    handler: async (_args, ctx) => {
      resetThread(ctx);
      notify(ctx, "Cleared BTW thread.", "info");
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Inject the full BTW thread into the main agent as a user message.",
    handler: async (args, ctx) => {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return;
      }

      const instructions = args.trim();
      const content = instructions
        ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(pendingThread)}`
        : `Here is a side conversation I had for additional context:\n\n${formatThread(pendingThread)}`;

      sendThreadToMain(ctx, content);
      const count = pendingThread.length;
      resetThread(ctx);
      notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Summarize the BTW thread, then inject the summary into the main agent.",
    handler: async (args, ctx) => {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to summarize.", "warning");
        return;
      }

      widgetStatus = "⏳ summarizing...";
      renderWidget(ctx);

      try {
        const summary = await summarizeThread(ctx, pendingThread);
        const instructions = args.trim();
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        sendThreadToMain(ctx, content);
        const count = pendingThread.length;
        resetThread(ctx);
        notify(ctx, `Injected BTW summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        widgetStatus = null;
        renderWidget(ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
