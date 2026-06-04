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
    in {
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-tools";
        version = "0.0.1";
        src = source;

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R . "$out/"
          runHook postInstall
        '';
      };

      pi-tools = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    });

    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_22
          pkgs.nodePackages.npm
        ];
      };
    });
  };
}
