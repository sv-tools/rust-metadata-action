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

- `matrix-mode`: Which rows `matrix` / `matrix-include` contain (default: `combined`).
  - `combined`: one row per feature, default features on (the original behavior).
  - `isolated`: per package, one `--no-default-features` row plus one `--no-default-features --features=<f>` row per
    non-`default` feature. Catches cfg-gated dead code and unused dependencies that only show up with a feature alone.
  - `both`: combined rows followed by isolated rows.
- `tag`: Release tag to parse and validate. Defaults to `github.ref` when it's a tag (`refs/tags/*`), so it works on
  `push: tags` and `release` events without configuration; on any other ref tag handling is skipped.
- `tag-format`: Tag naming convention (default: `{package}/v{version}`). Also used to build `release-order`. Use
  `{package}-v{version}` for release-plz style tags, or `v{version}` for a single-crate repository.

All four `*-exclude*` inputs are independent: each only affects its own output. The action validates every name against the actual `cargo metadata` and **fails** if any excluded package or feature isn't found in the workspace — a typo won't silently widen your matrix or publish set.

## Outputs

- `metadata`: Raw cargo metadata JSON.
- `packages`: JSON array (string) of package names, e.g. `["foo","bar"]`.
- `publish`: JSON array (string) of packages whose local `version` is strictly newer than the version on the registry — i.e. the set that actually needs to be published. The action runs `cargo info` for each publishable candidate and compares versions per semver. Packages declared `publish = false` are always excluded; packages not yet on the registry are included (first publish); packages restricted to a private registry via `publish = ["my-registry"]` are queried against that registry.
- `publish-waves`: `publish` grouped into dependency waves (JSON array of arrays). Crates in one wave don't depend on
  each other and can be tagged/published together; publish waves in order. E.g. `[["core"],["cli","macros"]]`.
- `release-order`: The tags to push for `publish`, in dependency order, built from `tag-format`. E.g.
  `["core/v0.2.0","cli/v1.1.0"]`.
- `new-crates`: The `publish` entries not on the registry yet. Each also gets a warning annotation: crates.io trusted
  publishing can't create a new crate, so publish its first version manually before tagging.
- `tag-package` / `tag-version`: The package and version from the release tag; empty when not running on a tag.
- `matrix`: JSON array (string) of command-line fragments suitable for use as a job matrix, e.g.
  `["--package=foo","--package=bar --features=foo"]`
- `matrix-include`: The same rows as `matrix`, as objects for `strategy.matrix.include`:
  `{"package":"foo","features":"full","args":"--package=foo --features=full","mode":"combined","lib":true,"bins":["foo"],"publish":true}`.
  `lib` tells you whether doctests / `cargo doc` apply; `bins` lists binary targets.
- `lib-packages`: Every package with a library target (`lib`, `rlib`, `dylib` or `proc-macro`; a `cdylib`+`rlib` crate
  counts, a `cdylib`-only crate doesn't).
- `bin-packages`: Every package with at least one binary target.
- `bins`: One `{"package","bin"}` object per binary target of each publishable package (honors `publish-exclude`), for a
  release-binaries matrix.
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

### Release one crate per tag

With tags like `<crate>/v<x.y.z>`, the action validates the tag and tells per-crate jobs which crate is being released —
no `startsWith(github.ref, …)` guards or shell parsing.

```yaml
on:
  push:
    tags: ["*/v*"]

jobs:
  meta:
    runs-on: ubuntu-latest
    outputs:
      tag-package: ${{ steps.rustmeta.outputs.tag-package }}
      tag-version: ${{ steps.rustmeta.outputs.tag-version }}
      bins: ${{ steps.rustmeta.outputs.bins }}
    steps:
      - uses: actions/checkout@v5
      # Fails here if the tag's version doesn't match Cargo.toml, or names an
      # unknown / publish = false package.
      - id: rustmeta
        uses: sv-tools/rust-metadata-action@v1

  binaries:
    needs: meta
    if: needs.meta.outputs.tag-package == 'my-cli'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: cargo build --release --package=my-cli
      - run: tar czf my-cli-${{ needs.meta.outputs.tag-version }}.tar.gz -C target/release my-cli
```

To plan a multi-crate release, read `release-order` (or `publish-waves`) on the main branch after the version bumps are
merged, and check `new-crates` before tagging:

```yaml
      - id: rustmeta
        uses: sv-tools/rust-metadata-action@v1
      - name: Release plan
        env:
          ORDER: ${{ steps.rustmeta.outputs.release-order }}
          NEW: ${{ steps.rustmeta.outputs.new-crates }}
        run: |
          echo "### Release order" >> "$GITHUB_STEP_SUMMARY"
          jq -r '.[] | "- `git push origin \(.)`"' <<< "$ORDER" >> "$GITHUB_STEP_SUMMARY"
          jq -r '.[] | "- ⚠️ \(.) is new: publish it manually first"' <<< "$NEW" >> "$GITHUB_STEP_SUMMARY"
```

### Structured and isolated matrix

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      include: ${{ steps.rustmeta.outputs.matrix-include }}
    steps:
      - uses: actions/checkout@v5
      - id: rustmeta
        uses: sv-tools/rust-metadata-action@v1
        with:
          matrix-mode: both
  test:
    needs: prepare
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include: ${{ fromJson(needs.prepare.outputs.include) }}
    env:
      RUSTFLAGS: -D warnings
    steps:
      - uses: actions/checkout@v5
      - run: cargo build ${{ matrix.args }}
      - run: cargo test ${{ matrix.args }}
      - if: matrix.lib
        run: cargo test --doc ${{ matrix.args }}
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
  - In `isolated` mode a package yields `--package=<name> --no-default-features` plus one
    `--package=<name> --no-default-features --features=<feature>` row per non-`default` feature. In `both` mode a
    featureless package gets only its combined row (the isolated one would be identical).
  - `publish = false` packages still appear in `packages` but are excluded from `publish`.
- `publish` filtering:
  - Each publishable candidate is checked with `cargo info`. Only packages whose Cargo.toml `version` is strictly greater than the latest on the registry are emitted.
  - Crates not yet on the registry (cargo info reports "could not find …") are included so a first-time publish goes through.
  - The list is sorted in dependency order: a crate comes after every workspace crate it depends on through a normal or
    build path dependency (renamed dependencies included). Dev-dependencies are ignored. Ties are broken by name.
  - If `cargo info` fails for any other reason (network, registry outage), that candidate is logged as a warning and skipped — the action errs on the side of *not* republishing rather than spuriously emitting a stale package.

## License

MIT licensed. See the bundled [LICENSE](LICENSE) file for more details.
