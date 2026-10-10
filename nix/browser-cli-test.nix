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
          home = {
            homeDirectory = lib.mkOption { type = lib.types.str; default = "/no-user-home"; };
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
true
