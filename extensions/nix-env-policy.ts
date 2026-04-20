import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NIX_HINTS = `Environment notes:
- This machine is NixOS.
- Do not assume tools, runtimes, or libraries are globally installed.
- Do not treat the presence of Python or Bun as proof that the needed environment is ready; required packages, modules, and CLIs may still be missing.
- Do not suggest apt, yum, brew, or global pip installs.
- If a known dedicated CLI fits the task, use that CLI in an existing or prepared flake shell before considering custom scraping or scripting.
- Do not replace a suitable CLI with ad-hoc Python or Bun scripting just because Python or Bun is available.
- Use scripting only after ruling out a suitable dedicated CLI, or when scripting is clearly the better tool for the user’s request.
- If scripting is needed, first prepare the environment with a flake dev shell instead of assuming packages are available.
- Shell selection order:
  - For project work, first inspect ./flake.nix and use the project shell if available, preferably devShells.<system>.pi, then default.
  - For general reusable tasks, first reuse an existing shell under ~/dev/pi-agent-shells/<name> if one fits.
  - Only create a new reusable shell when no suitable existing shell is available.
- Prefer nix develop <target> -c <command> for one-off execution.
- New reusable shells should be minimal, task-specific, and not near-duplicates of existing shells.`;

export default function nixosHints(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${NIX_HINTS}`,
    };
  });
}
