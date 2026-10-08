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
  imports = [
    (import ./herdr.nix {inherit self;})
    (lib.mkRenamedOptionModule ["programs" "pi-tools" "browserCheck"] ["programs" "pi-tools" "browserCli"])
  ];

  options.programs.pi-tools = {
    enable = lib.mkEnableOption "pi-tools opinionated pi configuration";

    package = lib.mkOption {
      type = lib.types.path;
      default =
        if cfg.browserCli.enable
        then self.packages.${pkgs.stdenv.hostPlatform.system}.default
        else self.packages.${pkgs.stdenv.hostPlatform.system}.without-browser-cli;
      defaultText = lib.literalExpression "pi-tools package, with or without browser-cli based on browserCli.enable";
      description = "The pi package directory exposed to pi. The default excludes browser-cli when browserCli.enable is false.";
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
        "${self.packages.${pkgs.stdenv.hostPlatform.system}.cliproxyapi-provider}"
      ];
      description = "Default recommended pi package entries. Set to [] to disable them.";
    };

    telegram = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkEnableOption "Pi session attachment commands for the Telegram daemon";
        };
      };
      default = {};
      description = "Pi session attachment to the agent-bridge daemon.";
    };

    agentBridge = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = cfg.telegram.enable;
            description = "Install the Bun agent-bridge CLI. Defaults to telegram.enable.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = self.packages.${pkgs.stdenv.hostPlatform.system}.agent-bridge;
            defaultText = lib.literalExpression "inputs.pi-tools.packages.\${pkgs.stdenv.hostPlatform.system}.agent-bridge";
            description = "Agent bridge CLI package.";
          };
        };
      };
      default = {};
      description = "Daemon-owned Telegram bot and local Pi session attachment.";
    };

    browserCli = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Install the browser-cli CLI on PATH.";
          };

          package = lib.mkOption {
            type = lib.types.package;
            default = self.packages.${pkgs.stdenv.hostPlatform.system}.browser-cli;
            defaultText = lib.literalExpression "inputs.pi-tools.packages.\${pkgs.stdenv.hostPlatform.system}.browser-cli";
            description = "Browser CLI package to install into home.packages.";
          };
        };
      };
      default = {};
      description = "Browser CLI and skill installation. Disable to omit both and their Playwright dependency from the default pi package.";
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
      lib.optional cfg.agentBridge.enable cfg.agentBridge.package
      ++ lib.optional cfg.browserCli.enable cfg.browserCli.package
      ++ lib.optional (cfg.piCliPackage != null) cfg.piCliPackage
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
