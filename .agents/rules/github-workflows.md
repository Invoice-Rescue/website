# GitHub Workflows & CI/CD Security Rules

This document outlines mandatory policies for all GitHub Actions workflows in this repository, grounded in authoritative [GitHub Documentation](https://docs.github.com/en/actions).

---

## 1. Least-Privilege Permissions

- **Mandatory Permissions Block**: Every workflow file must explicitly define a top-level `permissions` block.
- **Default Read-Only**: Standard validation workflows (`ci.yml`, `security.yml`) must declare:
  ```yaml
  permissions:
    contents: read
  ```
- **Prohibited**: Broad permissions (`permissions: write-all` or omitting `permissions`) are prohibited. Write access must be scoped to specific jobs requiring it (e.g. `contents: write`, `pull-requests: write` for Dependabot auto-merge).

---

## 2. Concurrency & Waste Prevention

- Every pull-request and branch-triggered workflow must include a `concurrency` block:
  ```yaml
  concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
  ```
- This ensures that outdated commits do not consume GitHub Actions minutes or cause race conditions.

---

## 3. Action Supply-Chain Security

- **Pinned Versions**: Use official GitHub-maintained actions pinned to specific major versions (e.g., `actions/checkout@v4`, `actions/setup-node@v4`).
- **Dependabot Governance**: Maintain automated weekly dependency checks in `.github/dependabot.yml` to keep actions up to date with security patches.
- **No Direct Shell Interpolation of Untrusted Context**: Never directly interpolate user-controlled context (such as `${{ github.event.issue.title }}` or `${{ github.event.comment.body }}`) into inline bash `run:` scripts. Pass them as environment variables instead.

---

## 4. Secret Protection

- Production credentials and API keys must only be referenced via `${{ secrets.* }}`.
- Never commit test API keys or credentials to workflow YAML files.
