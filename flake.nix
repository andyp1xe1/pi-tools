{
  description = "pi tools, extensions, skills, and development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = {
    self,
    nixpkgs,
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
      mkPiTools = withBrowserCheck: pkgs.stdenvNoCC.mkDerivation {
        pname = if withBrowserCheck then "pi-tools" else "pi-tools-without-browser-check";
        version = "0.0.1";
        src = source;

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R . "$out/"
          ${pkgs.lib.optionalString withBrowserCheck ''
            ln -s ${self.packages.${pkgs.stdenv.hostPlatform.system}.browser-check}/lib/node_modules/pi-tools/node_modules "$out/node_modules"
          ''}
          ${pkgs.lib.optionalString (!withBrowserCheck) ''
            rm -r "$out/skills/browser-check" "$out/src/browser-check" "$out/tests/browser-check"
            rm "$out/bin/browser-check.mjs"
          ''}
          runHook postInstall
        '';
      };
    in rec {
      browser-check = pkgs.buildNpmPackage {
        pname = "pi-tools-browser-check";
        version = "0.0.1";
        src = source;
        npmDepsHash = "sha256-ztWdXt+/3d6zd/FhgRYIdAuGjCbqUfTaY6CObFIm1xs=";
        npmFlags = ["--omit=dev"];
        dontNpmBuild = true;
        nativeBuildInputs = [pkgs.makeWrapper];
        postInstall = ''
          wrapProgram "$out/bin/browser-check" \
            --set-default FFMPEG_PATH ${pkgs.ffmpeg}/bin/ffmpeg \
            --set BROWSER_CHECK_REVISION ${self.rev or (self.dirtyRev or "unknown")}
        '';
      };

      default = mkPiTools true;
      without-browser-check = mkPiTools false;

      pi-tools = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
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
