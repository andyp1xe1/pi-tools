import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ensureDevShellSchema = Type.Object({
  name: Type.String({
    description: "Shell name. Used as the reusable shell directory name under ~/dev/pi-agent-shells/<name>.",
  }),
  cliPackages: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "nixpkgs package attribute names to include directly in pkgs.packages, e.g. ['yt-dlp', 'ffmpeg'] or ['jq'].",
    }),
  ),
  pythonPackages: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "nixpkgs python3Packages attribute names, e.g. ['requests', 'beautifulsoup4']. If provided, Python is included in the shell.",
    }),
  ),
  bunPackages: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Bun package names for a generated package.json, e.g. ['hono', 'zod']. If provided, bun is included in the shell.",
    }),
  ),
});

type EnsureDevShellInput = {
  name: string;
  cliPackages?: string[];
  pythonPackages?: string[];
  bunPackages?: string[];
};

function normalizeName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "shell"
  );
}

function uniqueSorted(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean))).sort();
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function buildFlakeContent(input: EnsureDevShellInput): string {
  const cliPackages = uniqueSorted(input.cliPackages);
  const pythonPackages = uniqueSorted(input.pythonPackages);
  const needsPython = hasOwnKey(input, "pythonPackages");
  const needsBun = hasOwnKey(input, "bunPackages");

  const packageLines: string[] = [];

  if (needsPython) {
    if (pythonPackages.length > 0) {
      packageLines.push(`            (python3.withPackages (ps: with ps; [ ${pythonPackages.join(" ")} ]))`);
    } else {
      packageLines.push("            python3");
    }
  }

  if (needsBun) {
    packageLines.push("            bun");
  }

  for (const pkg of cliPackages) {
    packageLines.push(`            ${pkg}`);
  }

  return `{
  description = ${JSON.stringify(`Reusable pi shell for ${input.name}`)};

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
${packageLines.join("\n")}
          ];
        };
      });
}
`;
}

function buildReadmeContent(input: EnsureDevShellInput, target: string, packageJsonWritten: boolean): string {
  const cliPackages = uniqueSorted(input.cliPackages);
  const pythonPackages = uniqueSorted(input.pythonPackages);
  const bunPackages = uniqueSorted(input.bunPackages);
  const lines = [`# ${input.name}`, "", "## Usage", "", "```bash", `nix develop ${target} -c <command>`, "```"];

  if (cliPackages.length > 0) {
    lines.push("", "## cli packages", "", ...cliPackages.map((pkg) => `- ${pkg}`));
  }

  if (hasOwnKey(input, "pythonPackages")) {
    lines.push(
      "",
      "## python",
      "",
      pythonPackages.length > 0 ? "Python plus requested pythonPackages are included." : "Python runtime is included.",
    );
    if (pythonPackages.length > 0) {
      lines.push("", ...pythonPackages.map((pkg) => `- ${pkg}`));
    }
  }

  if (hasOwnKey(input, "bunPackages")) {
    lines.push("", "## bun", "", "Bun runtime is included.");
    if (packageJsonWritten) {
      lines.push("A package.json with bun dependencies was generated.");
    }
    if (bunPackages.length > 0) {
      lines.push("", ...bunPackages.map((pkg) => `- ${pkg}`));
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildPackageJsonContent(name: string, bunPackages: string[]): string {
  const dependencies = Object.fromEntries(bunPackages.map((pkg) => [pkg, "latest"]));
  return `${JSON.stringify(
    {
      name: normalizeName(name),
      private: true,
      dependencies,
    },
    null,
    2,
  )}\n`;
}

export default function devShellManager(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ensure_dev_shell",
    label: "Ensure Dev Shell",
    description: "Create a minimal reusable Nix flake dev shell under ~/dev/pi-agent-shells/<name>.",
    promptSnippet: "Create a minimal reusable flake dev shell for CLI, Python, or Bun tasks on NixOS.",
    promptGuidelines: [
      "Use this before writing scripts that depend on runtimes or tools that may not be installed.",
      "Use this only for reusable shells under ~/dev/pi-agent-shells/<name>.",
      "For project-specific work, prefer reading and editing the project root flake directly instead of creating a shell here.",
      "Pass nixpkgs package attribute names in cliPackages, python3Packages attribute names in pythonPackages, and bun dependency names in bunPackages.",
    ],
    parameters: ensureDevShellSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
      const params = rawParams as EnsureDevShellInput;
      const shellName = normalizeName(params.name);
      const baseDir = join(homedir(), "dev", "pi-agent-shells", shellName);
      const flakePath = join(baseDir, "flake.nix");
      const readmePath = join(baseDir, "README.md");
      const packageJsonPath = join(baseDir, "package.json");
      const target = baseDir;

      const cliPackages = uniqueSorted(params.cliPackages);
      const bunPackages = uniqueSorted(params.bunPackages);
      const needsPython = hasOwnKey(params, "pythonPackages");
      const needsBun = hasOwnKey(params, "bunPackages");

      if (cliPackages.length === 0 && !needsPython && !needsBun) {
        return {
          content: [
            {
              type: "text",
              text: "No shell contents requested. Provide at least one of cliPackages, pythonPackages, or bunPackages.",
            },
          ],
          details: { created: false },
        };
      }

      const flakeContent = buildFlakeContent(params);
      let packageJsonWritten = false;

      await withFileMutationQueue(flakePath, async () => {
        await mkdir(dirname(flakePath), { recursive: true });
        await writeFile(flakePath, flakeContent, "utf8");
      });

      if (needsBun) {
        const packageJsonContent = buildPackageJsonContent(params.name, bunPackages);
        await withFileMutationQueue(packageJsonPath, async () => {
          await mkdir(dirname(packageJsonPath), { recursive: true });
          await writeFile(packageJsonPath, packageJsonContent, "utf8");
        });
        packageJsonWritten = true;
      }

      const readmeContent = buildReadmeContent(params, target, packageJsonWritten);
      await withFileMutationQueue(readmePath, async () => {
        await mkdir(dirname(readmePath), { recursive: true });
        await writeFile(readmePath, readmeContent, "utf8");
      });

      const notes = [`Created reusable dev shell at ${flakePath}.`, `Use it with: nix develop ${target} -c <command>`];
      if (packageJsonWritten) notes.push(`Generated ${packageJsonPath} for bun dependencies.`);

      return {
        content: [{ type: "text", text: notes.join(" ") }],
        details: {
          created: true,
          path: flakePath,
          readmePath,
          packageJsonPath: packageJsonWritten ? packageJsonPath : undefined,
          target,
        },
      };
    },
  });
}
