# Releasing step2glb

## Requirements

- A public GitHub repository and a public npm package. Provenance generation needs both.
- npm CLI 11.5.1 or later. The release workflow checks this.
- The `repository.url` value in `package.json` must match this repository exactly.

## One-time setup

1. On npmjs.com open the package, then Settings, then Trusted Publisher.
2. Add a GitHub Actions publisher:
   - Organization or user: `m1chlcz`
   - Repository: `step2glb`
   - Workflow filename: `release.yml`
   - Environment name: leave empty
   - Allowed actions: enable **Allow npm publish**. Configurations created after September 3, 2026 allow only staged publishing by default, so direct `npm publish` in the workflow fails without this option.
3. Save the publisher. npm checks the configuration only at publish time.
4. After the first successful release, open Settings, then Publishing access, and select "Require two-factor authentication and disallow tokens". Revoke tokens that are no longer needed.

## Releasing a version

1. Bump the version in `package.json` (for example `npm version patch --no-git-tag-version`).
2. Commit the change and push it to `main`.
3. Create an annotated tag and push it: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. The release workflow verifies that the tag matches the package version, runs the typecheck, the tests and the build, and publishes to npm with provenance.

A version with a prerelease suffix (for example `0.2.0-rc.1`) is published to the `next` dist-tag. Promote it with:

```sh
npm dist-tag add step2glb@<version> latest
```

The promote command needs interactive authentication. Running `npm dist-tag` inside the workflow instead needs the **Allow npm dist-tag** option on the trusted publisher and npm 11.21 or later.

## Dependency updates

- Dependabot opens grouped weekly pull requests for npm and GitHub Actions updates. Merge them after CI passes.
- Cut a patch release when a runtime dependency changes.
- The weekly canary workflow installs the newest versions of the key dependencies and runs the suite. A failure opens an issue titled "Canary: latest dependencies fail".

## Support

- The latest minor version and the previous minor version receive security patches.
- Retire a broken version with `npm deprecate step2glb@<version> "reason"`.
