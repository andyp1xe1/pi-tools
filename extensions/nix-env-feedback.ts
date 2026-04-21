import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations, getAgentDir, isBashToolResult, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATS_FILE = join(getAgentDir(), "extensions", "pi-nix-tools-missing-tools.json");
const NIX_CONFIG_SUGGESTION_THRESHOLD = 5;

type CommandSource = "bash-tool" | "user-bash";

interface MissingToolStat {
  count: number;
  firstSeen: string;
  lastSeen: string;
  lastCommand?: string;
  sources: Partial<Record<CommandSource, number>>;
}

interface MissingToolStatsFile {
  version: 1;
  updatedAt: string;
  executables: Record<string, MissingToolStat>;
}

const emptyStats = (): MissingToolStatsFile => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  executables: {},
});

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractMissingExecutable(output: string): string | undefined {
  const patterns = [
    /(?:^|\n).*?:\s*(?:line\s+\d+:\s+)?([^:\s]+): command not found(?:\n|$)/i,
    /(?:^|\n)([^:\s]+): command not found(?:\n|$)/i,
    /(?:^|\n).*?exec: ([^:\s]+): not found(?:\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function parseExitCodeFromOutput(output: string): number | undefined {
  const match = output.match(/exit code: (\d+)/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function isMissingCommandFailure(exitCode: number | undefined, output: string): boolean {
  const missingExecutable = extractMissingExecutable(output);
  if (!missingExecutable) return false;
  return exitCode === 127 || /command not found/i.test(output) || /exec: .*: not found/i.test(output);
}

function buildHint(executable: string, stat: MissingToolStat | undefined): string {
  const suggestion = (stat?.count ?? 0) >= NIX_CONFIG_SUGGESTION_THRESHOLD
    ? " If this keeps coming up, it may be worth suggesting that the user add it to their Nix config."
    : "";
  return `Nix env hint: ${executable} is missing in the current environment. Treat this as a shell-selection problem: try the project flake first, then a suitable shell under ~/dev/pi-agent-shells.${suggestion}`;
}

export default function commandTracker(pi: ExtensionAPI) {
  let stats: MissingToolStatsFile | undefined;
  let loaded = false;

  async function loadStats() {
    if (loaded) return;
    loaded = true;

    try {
      const raw = await readFile(STATS_FILE, "utf8");
      const parsed = JSON.parse(raw) as MissingToolStatsFile;
      if (parsed.version !== 1) throw new Error("unsupported stats version");
      stats = parsed;
    } catch {
      stats = emptyStats();
      await withFileMutationQueue(STATS_FILE, async () => {
        await rm(STATS_FILE, { force: true });
      });
    }
  }

  async function saveStats() {
    if (!stats) return;

    await withFileMutationQueue(STATS_FILE, async () => {
      await mkdir(dirname(STATS_FILE), { recursive: true });
      await writeFile(STATS_FILE, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
    });
  }

  async function recordMissingExecutable(executable: string, command: string, source: CommandSource) {
    await loadStats();
    if (!stats) return;

    const now = new Date().toISOString();
    const normalizedCommand = normalizeWhitespace(command);
    const existing = stats.executables[executable];

    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.lastCommand = normalizedCommand;
      existing.sources[source] = (existing.sources[source] ?? 0) + 1;
    } else {
      stats.executables[executable] = {
        count: 1,
        firstSeen: now,
        lastSeen: now,
        lastCommand: normalizedCommand,
        sources: { [source]: 1 },
      };
    }

    stats.updatedAt = now;
    await saveStats();
  }

  pi.on("session_start", async () => {
    await loadStats();
  });

  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;

    const command = typeof event.input.command === "string" ? event.input.command : "";
    const output = extractTextContent(event.content as Array<{ type: string; text?: string }>);
    const exitCode = parseExitCodeFromOutput(output);

    if (!isMissingCommandFailure(exitCode, output)) return;

    const executable = extractMissingExecutable(output);
    if (!executable) return;

    await recordMissingExecutable(executable, command, "bash-tool");
    const stat = stats?.executables[executable];

    pi.sendMessage(
      {
        customType: "pi-nix-tools-hint",
        content: buildHint(executable, stat),
        display: false,
        details: {
          kind: "missing-command",
          command: normalizeWhitespace(command),
          executable,
          seenCount: stat?.count ?? 1,
        },
      },
      { deliverAs: "steer" },
    );
  });

  pi.on("user_bash", async (event) => {
    const local = createLocalBashOperations();
    let output = "";

    return {
      operations: {
        async exec(command, cwd, options) {
          const result = await local.exec(command, cwd, {
            ...options,
            onData(data) {
              output += data.toString();
              options.onData(data);
            },
          });

          if (isMissingCommandFailure(result.exitCode ?? undefined, output)) {
            const executable = extractMissingExecutable(output);
            if (executable) {
              await recordMissingExecutable(executable, command, "user-bash");
            }
          }

          return result;
        },
      },
    };
  });

  pi.registerCommand("cmdstats", {
    description: "Show missing executable stats, or reset them",
    handler: async (args, ctx) => {
      await loadStats();
      const query = normalizeWhitespace(args || "");
      const current = stats ?? emptyStats();

      if (query === "reset") {
        stats = emptyStats();
        await withFileMutationQueue(STATS_FILE, async () => {
          await rm(STATS_FILE, { force: true });
        });
        ctx.ui.notify(`Reset missing tool stats and removed ${STATS_FILE}`, "info");
        return;
      }

      if (!query) {
        const topMissing = Object.entries(current.executables)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 10);

        const lines = ["Most frequently missing executables (limit 10)"];
        for (const [index, [name, stat]] of topMissing.entries()) {
          lines.push(`${index + 1}. ${name} — ${stat.count}`);
        }
        if (topMissing.length === 0) lines.push("(none yet)");
        lines.push("", `Stats file: ${STATS_FILE}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const stat = current.executables[query];
      const lines = [`Stats for: ${query}`, ""];

      if (!stat) {
        lines.push("No missing-tool stats recorded yet.");
      } else {
        lines.push(`Missing count: ${stat.count}`);
        lines.push(`First seen: ${stat.firstSeen}`);
        lines.push(`Last seen: ${stat.lastSeen}`);
        if (stat.lastCommand) lines.push(`Last command: ${stat.lastCommand}`);
      }

      lines.push("", `Stats file: ${STATS_FILE}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
