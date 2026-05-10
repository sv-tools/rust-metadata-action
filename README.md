# rust-metadata-action

GitHub Action to collect Cargo/Rust project metadata (packages, features, publishable packages and a ready-to-use job
matrix).

## What it does

- Runs `cargo metadata` for the repository (or a specified manifest) and extracts useful information about packages and
  features.
- Exposes outputs for raw metadata and parsed lists so subsequent workflow steps can use them (for example to publish
  crates, run tests per-package, or build per-feature).

## Inputs

- `manifest-path`: Path to `Cargo.toml` (default: `"Cargo.toml"`).
- `packages-exclude`: Comma-separated list of package names to drop from the `packages` output.
- `publish-exclude`: Comma-separated list of package names to drop from the `publish` output. Useful for crates that are publishable per Cargo.toml but you never want this workflow to publish (e.g. mirrored or vendored copies).
- `matrix-exclude-packages`: Comma-separated list of package names to drop from the `matrix` output. Excluded packages may still appear in `packages` and `publish` — only matrix rows are suppressed.
- `matrix-exclude-features`: Comma-separated list of features to drop from `matrix` rows. Each entry is either `<feature>` (excluded from every package that declares it) or `<package>:<feature>` (scoped to a single package). If every feature of a package ends up excluded, the package contributes no matrix rows — there is no bare `--package=` fallback.

All four `*-exclude*` inputs are independent: each only affects its own output. The action validates every name against the actual `cargo metadata` and **fails** if any excluded package or feature isn't found in the workspace — a typo won't silently widen your matrix or publish set.

## Outputs

- `metadata`: Raw cargo metadata JSON.
- `packages`: JSON array (string) of package names, e.g. `["foo","bar"]`.
- `publish`: JSON array (string) of packages whose local `version` is strictly newer than the version on the registry — i.e. the set that actually needs to be published. The action runs `cargo info` for each publishable candidate and compares versions per semver. Packages declared `publish = false` are always excluded; packages not yet on the registry are included (first publish); packages restricted to a private registry via `publish = ["my-registry"]` are queried against that registry.
- `matrix`: JSON array (string) of command-line fragments suitable for use as a job matrix, e.g.
  `["--package=foo","--package=bar --features=foo"]`
- `rust-version`: Workspace MSRV — the highest `rust-version` declared by any package, compared numerically (so `1.10`
  beats `1.9`). Empty string if no package declares one. Useful as input to `actions-rust-lang/setup-rust-toolchain`.
- `edition`: The newest Rust edition used by any package (e.g. `2021`, `2024`). Empty string for an empty workspace.

## Examples

### Example workflow snippet (consume outputs):

```yaml
jobs:
  metadata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Get Rust metadata
        id: rustmeta
        uses: sv-tools/rust-metadata-action@v1
        # Optional: skip specific packages or features. Each input is a
        # comma-separated list. Names are validated against cargo metadata —
        # a typo fails the action.
        # with:
        #   packages-exclude: experimental-pkg
        #   publish-exclude: vendored-crate
        #   matrix-exclude-packages: experimental-pkg, internal-tool
        #   matrix-exclude-features: unstable, foo:nightly
      - name: Show packages
        run: |
          echo "Packages: ${{ steps.rustmeta.outputs.packages }}"
          echo "Publishable: ${{ steps.rustmeta.outputs.publish }}"
```

### Use as a job matrix

You can convert the matrix output into a job matrix for per-package jobs. The action emits `matrix` and `publish` as
JSON; use `fromJson` to parse them.

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.rustmeta.outputs.matrix }}
      publish: ${{ steps.rustmeta.outputs.publish }}
    steps:
      - uses: actions/checkout@v5
      - name: Get matrix
        id: rustmeta
        uses: sv-tools/rust-metadata-action@v1
  test:
    needs: prepare
    runs-on: ubuntu-latest
    strategy:
      matrix:
        args: ${{ fromJson(needs.prepare.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v5
      - name: Test per-package and per-feature
        run: cargo test ${{ matrix.args }}

  build:
    needs: prepare
    runs-on: ubuntu-latest
    strategy:
      matrix:
        args: ${{ fromJson(needs.prepare.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v5
      - name: Build per-package
        run: cargo build ${{ matrix.args }}

  publish:
    needs: prepare
    runs-on: ubuntu-latest
    # use the 'publish' output (array of package names) as the matrix
    strategy:
      matrix:
        package: ${{ fromJson(needs.prepare.outputs.publish) }}
    steps:
      - uses: actions/checkout@v5
      - name: Publish crate (dry-run)
        run: cargo publish -p ${{ matrix.package }} --dry-run
      # Uncomment the real publish step once you're ready to publish for real
      #   run: cargo publish -p ${{ matrix.package }}
```

## Notes

- The action expects a Rust workspace or package with a `Cargo.toml`. If your manifest lives in a subdirectory, set
  `manifest-path` accordingly.
- Outputs are emitted as JSON strings; use `fromJson` in workflows when you need native arrays or objects.
- If your project has a `rust-toolchain.toml` (or `rust-toolchain`) next to the manifest, the action installs the
  pinned toolchain via `rustup toolchain install` before reading metadata. `rustup` is preinstalled on GitHub-hosted
  runners; on self-hosted runners ensure it's on `PATH`.
- Matrix output behavior:
  - A package with no features yields one row: `--package=<name>`.
  - A package with features yields one row per feature: `--package=<name> --features=<feature>` — there is no
    additional bare `--package=<name>` row in this case. The intent is to drive `cargo {test,build}` per feature
    rather than to also test "no features".
  - `publish = false` packages still appear in `packages` but are excluded from `publish`.
- `publish` filtering:
  - Each publishable candidate is checked with `cargo info`. Only packages whose Cargo.toml `version` is strictly greater than the latest on the registry are emitted.
  - Crates not yet on the registry (cargo info reports "could not find …") are included so a first-time publish goes through.
  - If `cargo info` fails for any other reason (network, registry outage), that candidate is logged as a warning and skipped — the action errs on the side of *not* republishing rather than spuriously emitting a stale package.

## License

MIT licensed. See the bundled [LICENSE](LICENSE) file for more details.
