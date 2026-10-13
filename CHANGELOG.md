# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `batch` command that converts files and directories in one run. Sources are
  processed in sorted order and each one writes `<out-dir>/<basename>.glb`.
  `--mapping-dir` picks up `<basename>.json` mapping files, `--recursive` walks
  directories, and a JSON summary is printed on stdout. The run continues after
  a failed file.
- `--preset web` and `--preset high` for `build` and `batch`, plus the
  `--linear-deflection`, `--angular-deflection`, `--quantize-position` and
  `--quantize-normal` flags that override the preset values.
- `--progress` for `build` and `batch`. The per-file stage lines go to stderr.
- Exported `PRESETS`, `DEFAULT_QUANTIZATION` and `resolveBuildOptions` for
  library users.

### Changed

- Usage errors now exit with code 2. Runtime errors keep exit code 1, and
  `batch` exits with code 1 when any file failed.
- STEP reader messages now go to stderr so stdout stays valid JSON for the
  summaries and the worker protocol.
