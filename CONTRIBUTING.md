# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

For building and running the extension locally, see the [Development](README.md#development) section in the README. This document covers the CI/release pipeline and the one-time repository setup needed for automatic publishing.

## CI / Release Pipeline

The repository has four workflows configured (`.github/workflows/`):

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Every push/PR to `main` | `npm ci` → build → unit tests → integration tests (real VS Code extension host) → `vsce package` → uploads the `.vsix` as a workflow artifact, publishes it as a `pr-<N>` prerelease, and comments a one-line install command on the PR |
| `pr-cleanup.yml` | A PR is closed | Deletes that PR's `pr-<N>` prerelease and tag so test builds don't pile up in the Releases list |
| `release-please.yml` | Push to `main` | Maintains a "Release PR" automatically based on [Conventional Commits](https://www.conventionalcommits.org/) messages (bumps the `package.json` version + `CHANGELOG.md`); merging it automatically tags a version and creates a GitHub Release, authenticated with a PAT (see below) so that Release can in turn trigger `publish.yml` |
| `publish.yml` | A GitHub Release is published (`release: published`), skipped for prereleases | Build → test → package the `.vsix` → attach it to the Release → publish to the VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`) |

### Grabbing a PR's test build

Every PR gets a comment with a ready-to-run install command, e.g.:

```bash
curl -fL -o remote-pulse-pr-8.vsix "https://github.com/tzzs/remote-pulse/releases/download/pr-8/remote-pulse-pr-8.vsix" && code --install-extension remote-pulse-pr-8.vsix
```

That build is a GitHub Release marked as a prerelease (not the "Latest" one — that stays whatever release-please last cut), gets overwritten on every push to the PR, and is deleted automatically once the PR closes.

In short, the full pipeline is: **everyday commits follow Conventional Commits (`feat: xxx` / `fix: xxx` / `chore: xxx`, …) → release-please opens a version PR → merging it cuts a GitHub Release automatically → that automatically pushes to both marketplaces**.

### One-Time Manual Setup (Repository Secrets)

Before the full pipeline (release-please → GitHub Release → both marketplaces) can work end to end, a few things need to be done manually, once:

1. **VS Code Marketplace**: register a publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) (make sure it matches `"publisher": "tanzz"` in `package.json`, or update that field to your actual publisher id), then generate a PAT in Azure DevOps with **Marketplace (Manage)** scope.
2. **Open VSX**: sign in at [open-vsx.org](https://open-vsx.org) with an Eclipse account, claim a namespace matching the publisher name (`npx ovsx create-namespace tanzz -p <token>`, or do it via the web UI), then generate an access token.
3. **GitHub PAT for release-please**: a Release created with the default `GITHUB_TOKEN` can't trigger another workflow — GitHub's built-in loop-prevention rule — so `release-please.yml` needs its own PAT (classic PAT with `repo` scope, or fine-grained with `Contents: write` + `Pull requests: write`) so the Release it publishes can go on to trigger `publish.yml`.
4. Add all three tokens to the repository Secrets (run this in your own terminal — don't paste tokens into chat):
   ```bash
   gh secret set VSCE_PAT --repo tzzs/remote-pulse
   gh secret set OVSX_PAT --repo tzzs/remote-pulse
   gh secret set RELEASE_PLEASE_TOKEN --repo tzzs/remote-pulse
   ```

Until `RELEASE_PLEASE_TOKEN` is configured, release-please's own PRs/Releases won't trigger `publish.yml` at all; until `VSCE_PAT`/`OVSX_PAT` are configured, `publish.yml` will run but fail at the Marketplace/Open VSX publish steps (build, test, package, and uploading the `.vsix` to the Release still succeed). Both are expected until setup is complete.
