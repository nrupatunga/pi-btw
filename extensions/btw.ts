import {
  BorderedLoader,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { streamSimple, type AssistantMessage, type ThinkingLevel as AiThinkingLevel } from "@mariozechner/pi-ai";
import { Box, Key, Text, matchesKey } from "@mariozechner/pi-tui";

const BTW_MESSAGE_TYPE = "btw-note";

type SessionThinkingLevel = "off" | AiThinkingLevel;

type BtwDetails = {
  question: string;
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

class BtwAnswerOverlay {
  private box: Box;

  constructor(
    private theme: Theme,
    private question: string,
    private answer: string,
    private saveState: SaveState,
    private done: () => void,
  ) {
    this.box = this.buildBox();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.done();
    }
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box = this.buildBox();
    this.box.invalidate();
  }

  dispose(): void {}

  private buildBox(): Box {
    const footer =
      this.saveState === "saved"
        ? this.theme.fg("success", "Saved to the session.")
        : this.saveState === "queued"
          ? this.theme.fg("success", "Will be saved after the current turn finishes.")
          : this.theme.fg("dim", "Not saved. Run /btw --save ... to persist it.");

    const lines = [
      this.theme.fg("accent", this.theme.bold("[BTW]")),
      "",
      this.theme.fg("dim", "Q:"),
      this.question,
      "",
      this.theme.fg("dim", "A:"),
      this.answer,
      "",
      footer,
      this.theme.fg("dim", "Enter/Esc to dismiss"),
    ];

    const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  }
}

function isBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function toReasoning(level: SessionThinkingLevel): AiThinkingLevel | undefined {
  return level === "off" ? undefined : level;
}

function extractAnswer(message: AssistantMessage): string {
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || "(No text response)";
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function buildBtwContext(ctx: ExtensionCommandContext, question: string) {
  const sessionContext = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  const messages = sessionContext.messages.filter((message) => !isBtwMessage(message));

  return {
    systemPrompt: ctx.getSystemPrompt(),
    messages: [
      ...messages,
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: question }],
        timestamp: Date.now(),
      },
    ],
  };
}

async function runBtw(
  ctx: ExtensionCommandContext,
  question: string,
  thinkingLevel: SessionThinkingLevel,
  signal?: AbortSignal,
): Promise<AssistantMessage | null> {
  const model = ctx.model;
  if (!model) {
    throw new Error("No active model selected.");
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    throw new Error(`No credentials available for ${model.provider}/${model.id}.`);
  }

  const stream = streamSimple(model, buildBtwContext(ctx, question), {
    apiKey,
    reasoning: toReasoning(thinkingLevel),
    signal,
  });

  const response = await stream.result();
  if (response.stopReason === "aborted") {
    return null;
  }
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "BTW request failed.");
  }

  return response;
}

function buildBtwMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function saveBtwNote(
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

async function showBtwAnswer(
  ctx: ExtensionCommandContext,
  question: string,
  answer: string,
  saveState: SaveState,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  await ctx.ui.custom<void>(
    (_tui, theme, _kb, done) => new BtwAnswerOverlay(theme, question, answer, saveState, () => done(undefined)),
    {
      overlay: true,
      overlayOptions: {
        width: "70%",
        maxHeight: "80%",
        minWidth: 50,
        anchor: "center",
        margin: 1,
      },
    },
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text btw message]";
    const lines = [theme.fg("accent", theme.bold("[BTW]")), content];

    if (expanded && details) {
      lines.push(
        theme.fg(
          "dim",
          `model: ${details.provider}/${details.model} · thinking: ${details.thinkingLevel}`,
        ),
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
      messages: event.messages.filter((message) => !isBtwMessage(message)),
    };
  });

  pi.registerCommand("btw", {
    description: "Ask a side question now. Add --save to persist the answer in the session.",
    handler: async (args, ctx) => {
      const { question, save } = parseBtwArgs(args);
      if (!question) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /btw [--save] <question>", "warning");
        }
        return;
      }

      if (!ctx.model) {
        if (ctx.hasUI) {
          ctx.ui.notify("No active model selected.", "error");
        }
        return;
      }

      const wasBusy = !ctx.isIdle();
      const model = ctx.model;
      const thinkingLevel = pi.getThinkingLevel() as SessionThinkingLevel;

      try {
        let response: AssistantMessage | null;

        if (ctx.hasUI) {
          response = await ctx.ui.custom<AssistantMessage | null>(
            (tui, theme, _kb, done) => {
              const status = wasBusy ? "in parallel with the current turn" : "now";
              const loader = new BorderedLoader(
                tui,
                theme,
                `Running /btw ${status} with ${model.provider}/${model.id} (${thinkingLevel})...`,
                { cancellable: true },
              );

              loader.onAbort = () => done(null);

              runBtw(ctx, question, thinkingLevel, loader.signal)
                .then(done)
                .catch((error) => {
                  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                  done(null);
                });

              return loader;
            },
            {
              overlay: true,
              overlayOptions: {
                width: "60%",
                minWidth: 40,
                anchor: "center",
                margin: 1,
              },
            },
          );
        } else {
          response = await runBtw(ctx, question, thinkingLevel);
        }

        if (!response) {
          if (ctx.hasUI) {
            ctx.ui.notify("/btw cancelled", "info");
          }
          return;
        }

        const answer = extractAnswer(response);
        const details: BtwDetails = {
          question,
          answer,
          provider: model.provider,
          model: model.id,
          thinkingLevel,
          timestamp: Date.now(),
          usage: response.usage,
        };

        const saveState = saveBtwNote(pi, details, save, wasBusy);

        if (ctx.hasUI) {
          await showBtwAnswer(ctx, question, answer, saveState);

          if (saveState === "saved") {
            ctx.ui.notify("Saved BTW note to the session.", "info");
          } else if (saveState === "queued") {
            ctx.ui.notify("BTW note queued to save after the current turn finishes.", "info");
          }
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
    },
  });
}
