{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi-tools;
  # Home Manager normally exports these through a shell; systemd does not
  # expand shell variables in Environment= values.
  serviceSessionPaths = map (path:
    lib.replaceStrings ["$HOME" "\${HOME}"] [config.home.homeDirectory config.home.homeDirectory] path
  ) (config.home.sessionPath or []);
  servicePath = lib.concatStringsSep ":" (lib.unique ([
    (lib.makeBinPath ([pkgs.bashInteractive pkgs.coreutils pkgs.git pkgs.nodejs_22 pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.diffutils pkgs.gzip pkgs.gnutar pkgs.which pkgs.openssh]
      ++ lib.optional cfg.audioTranscription.enable cfg.audioTranscription.package
      ++ cfg.agentBridge.service.extraPackages))
    "${config.home.homeDirectory}/.local/bin"
    "${config.home.homeDirectory}/.nix-profile/bin"
    "${config.home.profileDirectory or "${config.home.homeDirectory}/.nix-profile"}/bin"
  ] ++ serviceSessionPaths ++ ["/run/current-system/sw/bin"]));

  packagePath = "${cfg.package}";
  disabledExtensions =
    lib.optional (!cfg.bot.enable) "!extensions/bot.ts"
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

    bot = lib.mkOption {
      type = lib.types.submodule {
        options = {
          enable = lib.mkEnableOption "Pi session attachment commands for the agent bridge";
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
            default = cfg.bot.enable || cfg.agentBridge.service.enable;
            description = "Install the Bun agent-bridge CLI. Defaults to bot.enable or agentBridge.service.enable.";
          };
          package = lib.mkOption {
            type = lib.types.package;
            default = self.packages.${pkgs.stdenv.hostPlatform.system}.agent-bridge;
            defaultText = lib.literalExpression "inputs.pi-tools.packages.\${pkgs.stdenv.hostPlatform.system}.agent-bridge";
            description = "Agent bridge CLI package.";
          };
          service = {
            enable = lib.mkEnableOption "the agent-bridge systemd user service (Linux only)";
            environmentFile = lib.mkOption {
              type = lib.types.addCheck lib.types.str (lib.hasPrefix "/");
              default = "${config.xdg.configHome or "${config.home.homeDirectory}/.config"}/agent-bridge/env";
              description = "Absolute path to the existing private environment file. Secrets are read by the daemon, never copied into the Nix store.";
            };
            extraPackages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [];
              description = "Additional executables for managed agents. The service also uses the user's profile and system PATH, plus basic coding tools and optionally Whisper.";
            };
          };
        };
      };
      default = {};
      description = "Agent bridge daemon and local Pi session attachment.";
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
    assertions = [
      {
        assertion = !cfg.agentBridge.service.enable || pkgs.stdenv.isLinux;
        message = "programs.pi-tools.agentBridge.service.enable requires Linux/systemd.";
      }
      {
        assertion = !cfg.agentBridge.service.enable || cfg.agentBridge.enable;
        message = "Enable programs.pi-tools.agentBridge.enable when enabling its service.";
      }
    ];

    systemd.user.services = lib.mkIf (cfg.agentBridge.service.enable && pkgs.stdenv.isLinux) {
      agent-bridge = {
        Unit = {
          Description = "Agent bridge (Telegram and native saved Pi sessions)";
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };
        Service = {
          Type = "simple";
          ExecStart = "${cfg.agentBridge.package}/bin/agent-bridge start";
          WorkingDirectory = config.home.homeDirectory;
          Restart = "on-failure";
          RestartSec = "10s";
          TimeoutStopSec = "120s";
          KillMode = "control-group";
          UMask = "0077";
          Environment = [
            "HOME=${config.home.homeDirectory}"
            "XDG_CONFIG_HOME=${config.xdg.configHome or "${config.home.homeDirectory}/.config"}"
            "XDG_DATA_HOME=${config.xdg.dataHome or "${config.home.homeDirectory}/.local/share"}"
            "XDG_RUNTIME_DIR=%t"
            "AGENT_BRIDGE_ENV_FILE=${cfg.agentBridge.service.environmentFile}"
            "PATH=${servicePath}"
          ];
          # User managers can retain environment imported from a terminal. A service
          # must not impersonate that terminal's Herdr pane or saved Pi session.
          # Bridge configuration comes from its private file, not a stale trial
          # token/database/socket imported into the shared user manager.
          UnsetEnvironment = [
            "HERDR_ENV" "HERDR_PANE_ID" "HERDR_TAB_ID" "HERDR_WORKSPACE_ID"
            "HERDR_SOCKET_PATH" "HERDR_BIN_PATH" "PI_SESSION_ID" "PI_SESSION_FILE"
            "PI_MODEL" "PI_PROVIDER" "PI_REASONING_LEVEL"
            "PI_CODING_AGENT_DIR" "PI_CODING_AGENT_SESSION_DIR"
            "TELEGRAM_BOT_TOKEN" "AGENT_BRIDGE_OWNER_IDS"
            "AGENT_BRIDGE_DATABASE" "AGENT_BRIDGE_SOCKET"
            "AGENT_BRIDGE_WHISPER_MODEL" "AGENT_BRIDGE_WHISPER_LANGUAGE"
            "TMUX" "TMUX_PANE" "TMUX_TMPDIR"
          ];
        };
        Install.WantedBy = ["default.target"];
      };
    };

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
