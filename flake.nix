{
  description = "pi tools, extensions, skills, and development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    herdr-nix = {
      url = "github:herdrdev/herdr-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    herdr-src = {
      url = "github:herdrdev/herdr";
      flake = false;
    };
    cliproxyapi-provider-src = {
      url = "github:andyp1xe1/pi-cliproxyapi-provider/c3928c6f1e9d357515b08e3737b72b64051164fd";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];

    forAllSystems = f:
      nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs {
          inherit system;
        }));
  in {
    homeManagerModules = rec {
      pi-tools = import ./nix/home-manager.nix {inherit self;};
      default = pi-tools;
    };

    packages = forAllSystems (pkgs: let
      source = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = name: type: let
          base = baseNameOf name;
        in
          base != ".git"
          && base != "node_modules"
          && base != ".pi-pkm"
          && base != "dist"
          && base != "build"
          && base != "coverage";
      };
      mkPiTools = withBrowserCli: pkgs.stdenvNoCC.mkDerivation {
        pname = if withBrowserCli then "pi-tools" else "pi-tools-without-browser-cli";
        version = "0.0.1";
        src = source;

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R . "$out/"
          ${pkgs.lib.optionalString withBrowserCli ''
            ln -s ${self.packages.${pkgs.stdenv.hostPlatform.system}.browser-cli}/lib/node_modules/pi-tools/node_modules "$out/node_modules"
          ''}
          ${pkgs.lib.optionalString (!withBrowserCli) ''
            rm -r "$out/skills/browser-cli" "$out/src/browser-cli" "$out/tests/browser-cli"
            rm "$out/bin/browser-cli.mjs"
          ''}
          runHook postInstall
        '';
      };
    in rec {
      browser-cli = pkgs.buildNpmPackage {
        pname = "pi-tools-browser-cli";
        version = "0.0.1";
        src = source;
        npmDepsHash = "sha256-qBadhlYW2+8lliDlbeDT+y3zIQJFxqsS2XEcKxKTNUo=";
        npmFlags = ["--omit=dev"];
        dontNpmBuild = true;
        nativeBuildInputs = [pkgs.makeWrapper];
        postInstall = ''
          wrapProgram "$out/bin/browser-cli" \
            --set-default FFMPEG_PATH ${pkgs.ffmpeg}/bin/ffmpeg \
            --set BROWSER_CLI_REVISION ${self.rev or (self.dirtyRev or "unknown")}
        '';
      };

      cliproxyapi-provider = pkgs.runCommand "pi-cliproxyapi-provider-1.4.21-patched.1" {} ''
        mkdir -p "$out"
        cp -R ${self.inputs.cliproxyapi-provider-src}/. "$out/"
        chmod u+w "$out"
        mkdir -p "$out/node_modules/@andyp1xe1"
        ln -s ../../packages/codex-transport \
          "$out/node_modules/@andyp1xe1/cliproxyapi-codex-transport"
      '';

      default = mkPiTools true;
      without-browser-cli = mkPiTools false;

      pi-tools = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    });

    checks = forAllSystems (pkgs: {
      browser-cli-home-manager =
        assert import ./nix/browser-cli-test.nix {inherit self pkgs;};
        pkgs.runCommand "check-browser-cli-home-manager" {} ''
          touch "$out"
        '';

      cliproxyapi-transport = pkgs.runCommand "check-cliproxyapi-transport" {
        nativeBuildInputs = [pkgs.nodejs_22];
      } ''
        cd ${self.packages.${pkgs.stdenv.hostPlatform.system}.cliproxyapi-provider}
        node --input-type=module <<'JS'
        import assert from "node:assert/strict";
        import { streamSimple } from "@andyp1xe1/cliproxyapi-codex-transport";
        let requested = false;
        const result = await streamSimple({
          id: "test", provider: "cliproxyapi", baseUrl: "http://127.0.0.1:8317/backend-api",
          reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }, { messages: [] }, {
          apiKey: "plain-proxy-key", transport: "sse", maxRetries: 0,
          fetch: async (_url, request) => {
            requested = true;
            const headers = new Headers(request.headers);
            assert.equal(headers.get("Authorization"), "Bearer plain-proxy-key");
            assert.equal(headers.has("chatgpt-account-id"), false);
            return new Response("deliberate test error", { status: 400 });
          },
        }).result();
        assert(requested, result.errorMessage);
        assert.equal(result.api, "cliproxyapi-codex-responses");
        JS
        touch "$out"
      '';
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_22
          pkgs.ffmpeg
        ];
      };
    });
  };
}
