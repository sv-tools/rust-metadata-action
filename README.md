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

## Outputs

- `metadata`: Raw cargo metadata JSON.
- `packages`: JSON array (string) of package names, e.g. `["foo","bar"]`.
- `publish`: JSON array (string) of packages that can be published.
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

## License

MIT licensed. See the bundled [LICENSE](LICENSE) file for more details.
