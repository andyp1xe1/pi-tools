{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi-tools;

  packagePath = "${cfg.package}";

  baseSettings = lib.optionalAttrs (cfg.theme != null) {
    theme = cfg.theme;
  } // {
    quietStartup = true;
    collapseChangelog = true;
    showHardwareCursor = true;
    editorPaddingX = 1;
    npmCommand = cfg.npmCommand;
    packages = cfg.recommendedPackages ++ cfg.extraPackages ++ [packagePath];
  };
in {
  options.programs.pi-tools = {
    enable = lib.mkEnableOption "pi-tools opinionated pi configuration";

    package = lib.mkOption {
      type = lib.types.path;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.pi-tools.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The pi package directory exposed to pi.";
    };

    theme = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "gruvbox-dark";
      description = "Theme name written to pi settings. Set to null to omit a theme setting.";
    };

    recommendedPackages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = ["npm:pi-web-access"];
      description = "Default recommended pi package entries. Set to [] to disable the bundled recommendations.";
    };

    npmCommand = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = ["npm" "--prefix" "${config.home.homeDirectory}/.pi/npm-global"];
      defaultText = lib.literalExpression ''[ "npm" "--prefix" "${config.home.homeDirectory}/.pi/npm-global" ]'';
      description = "npm command pi should use for npm-backed pi packages.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = [
        "\${inputs.pi-telegram}"
        "npm:pi-web-access"
      ];
      description = "Additional pi package entries to place before the pi-tools package.";
    };

    piCliPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      example = lib.literalExpression "inputs.llm-agents.packages.\${pkgs.stdenv.hostPlatform.system}.pi";
      description = "Optional pi CLI package to install into home.packages. Set to null to skip CLI installation.";
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      default = {};
      description = "Extra pi settings merged over the pi-tools defaults.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = lib.optional (cfg.piCliPackage != null) cfg.piCliPackage;

    home.file = {
      ".pi/agent/settings.json".text = builtins.toJSON (baseSettings // cfg.settings);
    };
  };
}
