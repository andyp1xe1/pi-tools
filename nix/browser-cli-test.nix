# Unit-test module defaults and the browserCheck compatibility alias without
# requiring a Home Manager input or activating any user configuration.
{self, pkgs}: let
  lib = pkgs.lib;
  system = pkgs.stdenv.hostPlatform.system;
  packages = self.packages.${system};
  custom = pkgs.runCommand "custom-browser-cli" {} "mkdir -p $out";
  evaluate = settings: (lib.evalModules {
    specialArgs = {
      inherit pkgs;
      lib = lib // {
        hm.dag.entryAfter = after: data: {inherit after data;};
      };
    };
    modules = [
      (import ./home-manager.nix {inherit self;})
      {
        options = {
          warnings = lib.mkOption { type = lib.types.listOf lib.types.str; default = []; };
          assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = []; };
          systemd.user.services = lib.mkOption { type = lib.types.attrs; default = {}; };
          home = {
            homeDirectory = lib.mkOption { type = lib.types.str; default = "/no-user-home"; };
            profileDirectory = lib.mkOption { type = lib.types.str; default = "/etc/profiles/per-user/test-user"; };
            sessionPath = lib.mkOption { type = lib.types.listOf lib.types.str; default = ["/user/wrappers" "$HOME/go/bin" "\${HOME}/bin"]; };
            packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = []; };
            file = lib.mkOption { type = lib.types.attrs; default = {}; };
            activation = lib.mkOption { type = lib.types.attrs; default = {}; };
          };
        };
        config.programs.pi-tools = {
          enable = true;
          herdr.enable = false;
        } // settings;
      }
    ];
  }).config;
  enabled = evaluate {};
  disabled = evaluate { browserCli.enable = false; };
  oldDisabled = evaluate { browserCheck.enable = false; };
  oldCustom = evaluate { browserCheck.package = custom; };
  newCustom = evaluate { browserCli.package = custom; };
  merged = evaluate { browserCheck.enable = false; browserCli.package = custom; };
  botEnabled = evaluate { bot.enable = true; browserCli.enable = false; };
  botSettings = builtins.fromJSON (builtins.unsafeDiscardStringContext botEnabled.home.file.".pi/agent/settings.json".text);
  disabledSettings = builtins.fromJSON (builtins.unsafeDiscardStringContext disabled.home.file.".pi/agent/settings.json".text);
  serviceEnabled = evaluate { agentBridge.service.enable = true; browserCli.enable = false; };
  service = serviceEnabled.systemd.user.services.agent-bridge;
  serviceCustom = evaluate {
    agentBridge = {
      package = custom;
      service = { enable = true; environmentFile = "/private/bridge.env"; extraPackages = [custom]; };
    };
    audioTranscription.enable = true;
  };
  invalidService = evaluate { agentBridge = { enable = false; service.enable = true; }; };
in
assert enabled.programs.pi-tools.browserCli.enable;
assert enabled.programs.pi-tools.package == packages.default;
assert enabled.home.packages == [packages.browser-cli];
assert enabled.warnings == [];
assert disabled.programs.pi-tools.package == packages.without-browser-cli;
assert disabled.home.packages == [];
assert disabled.warnings == [];
assert oldDisabled.programs.pi-tools.package == disabled.programs.pi-tools.package;
assert oldDisabled.home.packages == [];
assert builtins.length oldDisabled.warnings == 1;
assert lib.hasInfix "browserCli" (builtins.head oldDisabled.warnings);
assert oldCustom.home.packages == [custom];
assert oldCustom.programs.pi-tools.browserCli.package == newCustom.programs.pi-tools.browserCli.package;
assert builtins.length oldCustom.warnings == 1;
assert merged.home.packages == [];
assert merged.programs.pi-tools.browserCli.package == custom;
assert botEnabled.programs.pi-tools.agentBridge.enable;
assert !(botEnabled.programs.pi-tools ? telegram);
assert botEnabled.home.packages == [packages.agent-bridge];
assert !(builtins.elem "!extensions/bot.ts" (lib.last botSettings.packages).extensions);
assert builtins.elem "!extensions/bot.ts" (lib.last disabledSettings.packages).extensions;
assert enabled.systemd.user.services == {};
assert botEnabled.systemd.user.services == {};
assert serviceEnabled.programs.pi-tools.agentBridge.enable;
assert serviceEnabled.home.packages == [packages.agent-bridge];
assert (builtins.all (row: row.assertion) serviceEnabled.assertions) == pkgs.stdenv.isLinux;
assert !(builtins.all (row: row.assertion) invalidService.assertions);
assert !pkgs.stdenv.isLinux || (
assert service.Service.ExecStart == "${packages.agent-bridge}/bin/agent-bridge start";
assert service.Service.Restart == "on-failure";
assert service.Service.RestartSec == "10s";
assert service.Service.WorkingDirectory == "/no-user-home";
assert service.Service.UMask == "0077";
assert service.Unit.StartLimitBurst == 5;
assert service.Install.WantedBy == ["default.target"];
assert builtins.elem "HERDR_ENV" service.Service.UnsetEnvironment;
assert builtins.elem "PI_SESSION_FILE" service.Service.UnsetEnvironment;
assert builtins.elem "AGENT_BRIDGE_SOCKET" service.Service.UnsetEnvironment;
assert builtins.elem "AGENT_BRIDGE_DATABASE" service.Service.UnsetEnvironment;
assert builtins.elem "TELEGRAM_BOT_TOKEN" service.Service.UnsetEnvironment;
assert !(builtins.elem "AGENT_BRIDGE_ENV_FILE" service.Service.UnsetEnvironment);
assert builtins.elem "AGENT_BRIDGE_ENV_FILE=/no-user-home/.config/agent-bridge/env" service.Service.Environment;
assert !(service.Service ? EnvironmentFile);
assert builtins.elem "XDG_RUNTIME_DIR=%t" service.Service.Environment;
assert builtins.any (value: lib.hasPrefix "PATH=" value && lib.hasInfix "/no-user-home/.local/bin:/no-user-home/.nix-profile/bin:/etc/profiles/per-user/test-user/bin:/user/wrappers:/no-user-home/go/bin:/no-user-home/bin:/run/current-system/sw/bin" value) service.Service.Environment;
assert builtins.all (value: !(lib.hasInfix "$HOME" value) && !(lib.hasInfix "\${HOME}" value)) service.Service.Environment;
assert serviceCustom.systemd.user.services.agent-bridge.Service.ExecStart == "${custom}/bin/agent-bridge start";
assert builtins.elem "AGENT_BRIDGE_ENV_FILE=/private/bridge.env" serviceCustom.systemd.user.services.agent-bridge.Service.Environment;
assert builtins.any (value: lib.hasPrefix "PATH=" value && lib.hasInfix (builtins.unsafeDiscardStringContext "${custom}/bin") value && lib.hasInfix (builtins.unsafeDiscardStringContext "${serviceCustom.programs.pi-tools.audioTranscription.package}/bin") value) serviceCustom.systemd.user.services.agent-bridge.Service.Environment;
true
);
true
