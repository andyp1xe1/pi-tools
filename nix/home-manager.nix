{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi-tools;

  packagePath = "${cfg.package}";
  disabledExtensions =
    lib.optional (!cfg.telegram.enable) "!extensions/telegram.ts"
    ++ lib.optional (!cfg.audioTranscription.enable) "!extensions/audio-transcription.ts";
  packageEntry =
    if disabledExtensions == []
    then packagePath
    else {
      source = packagePath;
      extensions = ["extensions/*.ts"] ++ disabledExtensions;
    };

  baseSettings = lib.optionalAttrs (cfg.theme != null) {
    theme = cfg.theme;
  } // {
    quietStartup = true;
    collapseChangelog = true;
    showHardwareCursor = true;
    editorPaddingX = 1;
    npmCommand = cfg.npmCommand;
    packages = cfg.recommendedPackages ++ cfg.extraPackages ++ [packageEntry];
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
      default = [
        "npm:pi-web-access@0.30.0"
      ];
      description = "Default recommended pi package entries. Set to [] to disable the bundled recommendations.";
    };

    telegram = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkEnableOption "the vendored pi Telegram bridge";
        };
      };
      default = {};
      description = "Telegram bridge integration.";
    };

    audioTranscription = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkEnableOption "local audio transcription with Whisper";

          package = lib.mkOption {
            type = lib.types.package;
            default = pkgs.openai-whisper;
            defaultText = lib.literalExpression "pkgs.openai-whisper";
            description = "Whisper package exposed to pi for local audio transcription.";
          };
        };
      };
      default = {};
      description = "Local audio transcription integration.";
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
        "npm:some-pi-package"
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
    home.packages =
      lib.optional (cfg.piCliPackage != null) cfg.piCliPackage
      ++ lib.optional cfg.audioTranscription.enable cfg.audioTranscription.package;

    home.file = {
      ".pi/agent/settings.json".text = builtins.toJSON (baseSettings // cfg.settings);
    };

    home.activation.piToolsInitNpmPrefix = lib.hm.dag.entryAfter ["writeBoundary"] ''
      prefix="${config.home.homeDirectory}/.pi/npm-global"
      run mkdir -p "$prefix"
      if [ ! -e "$prefix/package.json" ]; then
        run echo '{"name":"pi-extensions","private":true}' > "$prefix/package.json"
      fi
    '';
  };
}
