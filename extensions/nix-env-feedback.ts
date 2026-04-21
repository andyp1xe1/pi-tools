import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLocalBashOperations, getAgentDir, isBashToolResult, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STATS_FILE = join(getAgentDir(), "extensions", "pi-nix-tools-missing-tools.json");
const DEV_SHELLS_DIR = join(homedir(), "dev", "pi-agent-shells");
const NIX_CONFIG_SUGGESTION_THRESHOLD = 5;
const MAX_SHELL_HINTS = 6;

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

type ShellContext = {
  hasProjectFlake: boolean;
  matchingShells: string[];
};

function fuzzyKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzySubstringScore(needle: string, haystack: string): number {
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) return needle.length + 100;

  for (let length = needle.length - 1; length >= 3; length -= 1) {
    for (let start = 0; start + length <= needle.length; start += 1) {
      if (haystack.includes(needle.slice(start, start + length))) return length;
    }
  }

  return 0;
}

async function getShellContext(executable: string, cwd: string): Promise<ShellContext> {
  const hasProjectFlake = await readFile(join(cwd, "flake.nix"), "utf8")
    .then(() => true)
    .catch(() => false);

  const needle = fuzzyKey(executable);
  const minScore = Math.max(3, Math.ceil(needle.length * 0.6));
  const entries = await readdir(DEV_SHELLS_DIR, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ shellName: string; score: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const shellName = entry.name;
    const flakePath = join(DEV_SHELLS_DIR, shellName, "flake.nix");
    const nameScore = fuzzySubstringScore(needle, fuzzyKey(shellName));

    let contentScore = 0;
    if (nameScore < minScore) {
      const flakeContent = await readFile(flakePath, "utf8").catch(() => "");
      contentScore = fuzzySubstringScore(needle, fuzzyKey(flakeContent));
    }

    const score = Math.max(nameScore, contentScore);
    if (score >= minScore) {
      matches.push({ shellName, score });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.shellName.localeCompare(b.shellName));

  return {
    hasProjectFlake,
    matchingShells: matches.slice(0, MAX_SHELL_HINTS).map((match) => match.shellName),
  };
}

function buildHint(executable: string, stat: MissingToolStat | undefined, shellContext: ShellContext): string {
  const projectFlake = shellContext.hasProjectFlake ? "yes" : "no";
  const shellList = shellContext.matchingShells.length > 0
    ? ` Matching reusable shells: ${shellContext.matchingShells.join(", ")}.`
    : "";
  const suggestion = (stat?.count ?? 0) >= NIX_CONFIG_SUGGESTION_THRESHOLD
    ? " If it keeps coming up, consider suggesting it for the user's Nix config."
    : "";
  return `Nix env hint: ${executable} is missing here. Project flake: ${projectFlake}.${shellList} Try the project flake first, then a fitting reusable shell.${suggestion}`;
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

  pi.on("tool_result", async (event, ctx) => {
    if (!isBashToolResult(event)) return;

    const command = typeof event.input.command === "string" ? event.input.command : "";
    const output = extractTextContent(event.content as Array<{ type: string; text?: string }>);
    const exitCode = parseExitCodeFromOutput(output);

    if (!isMissingCommandFailure(exitCode, output)) return;

    const executable = extractMissingExecutable(output);
    if (!executable) return;

    await recordMissingExecutable(executable, command, "bash-tool");
    const stat = stats?.executables[executable];
    const shellContext = await getShellContext(executable, ctx.cwd);

    pi.sendMessage(
      {
        customType: "pi-nix-tools-hint",
        content: buildHint(executable, stat, shellContext),
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
