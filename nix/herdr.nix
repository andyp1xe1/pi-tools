{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  source = self.inputs.herdr-src;
  assets = "${source}/src/integration/assets";
  upstreamSkill = builtins.readFile "${source}/skills/herdr/SKILL.md";
  originalTrigger = "Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work.";
  preferredTrigger = "Use inside Herdr for delegated agents, parallel work, long-running commands, and pane control. The user need not mention Herdr.";
in {
  options.programs.pi-tools.herdr.enable = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Install Herdr with Gruvbox and visible, saved Pi delegation.";
  };

  config = lib.mkIf (config.programs.pi-tools.enable && config.programs.pi-tools.herdr.enable) {
    home.packages = [self.inputs.herdr-nix.packages.${pkgs.stdenv.hostPlatform.system}.default];
    home.file = {
      ".config/herdr/config.toml".text = ''
        onboarding = false

        [theme]
        name = "gruvbox"
        auto_switch = false
      '';
      ".pi/agent/extensions/herdr-agent-state.ts".source = "${assets}/pi/herdr-agent-state.ts";
      ".pi/agent/skills/herdr/SKILL.md".text =
        assert lib.hasInfix originalTrigger upstreamSkill;
        builtins.replaceStrings [originalTrigger] [preferredTrigger] upstreamSkill;
      ".pi/agent/AGENTS.md".text = builtins.readFile ./AGENTS.md;

      # OpenCode V1 uses separate server and TUI plugins.
      ".config/opencode/plugins/herdr-agent-state.js".source = "${assets}/opencode/herdr-agent-state.js";
      ".config/opencode/herdr-tui-session.js".source = "${assets}/opencode/herdr-tui-session.js";
      ".config/opencode/tui.jsonc".text = builtins.toJSON {
        plugin = ["./herdr-tui-session.js"];
      };
    };
  };
}
