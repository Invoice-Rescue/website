# Git Workflow & Collaboration Guide

This document defines the version control standards, branching models, commit conventions, and review processes for the `invoice-rescue` project.

---

## 1. Branching Strategy: GitHub Flow

We use **GitHub Flow** for continuous, reliable deployment:

```
main (protected, always deployable)
  │
  ├── feature/stripe-billing-portal   ──> PR ──> merge to main
  ├── fix/session-expiry-redirect      ──> PR ──> merge to main
  └── chore/update-wrangler-bindings   ──> PR ──> merge to main
```

### Branch Naming Conventions

- `feature/<short-slug>`: New user-facing or architectural features (e.g. `feature/export-csv-summary`)
- `fix/<short-slug>`: Bug fixes (e.g. `fix/interest-calculation-leap-year`)
- `chore/<short-slug>`: Dependency bumps, tooling, refactors (e.g. `chore/upgrade-workers-types`)
- `docs/<short-slug>`: Documentation-only updates (e.g. `docs/api-specs`)

---

## 2. Commit Conventions (Conventional Commits)

Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) standard.

### Structure

```
<type>(<scope>): <subject>

[optional body explaining why this change is necessary]

[optional footer(s), e.g. Closes #123, BREAKING CHANGE]
```

### Types

| Type | Purpose | Example |
| :--- | :--- | :--- |
| `feat` | New feature or capability | `feat(portal): add debtor payment link generation` |
| `fix` | Bug fix | `fix(interest): correct statutory rate formula` |
| `docs` | Documentation only | `docs(readme): add cloudflare deployment guide` |
| `refactor` | Code restructuring without behavior change | `refactor(db): extract client query helper` |
| `test` | Adding or updating tests | `test(escalation): add test case for final demand` |
| `chore` | Tooling, build config, dependencies | `chore(deps): update wrangler to 4.126.0` |
| `ci` | CI/CD changes | `ci: add automated worker typecheck` |

### Commit Template

The repository includes a [`.gitmessage`](../.gitmessage) template configured via:

```bash
git config commit.template .gitmessage
```

---

## 3. Pre-Commit Verification Hook

A local Git pre-commit hook is installed in `.git/hooks/pre-commit` to prevent common regressions:

1. **Secret Leak Detection:** Blocks staging of `.env*` or `.dev.vars` files and private key markers.
2. **Typecheck Gate:** Automatically executes `npm run typecheck` (`tsc --noEmit`) before allowing a commit to be created.

---

## 4. Pull Request & Review Process

1. **Keep branches small and focused:** Aim for single-concern PRs under 400 lines of diff.
2. **Update with Rebase before opening PR:**

   ```bash
   git checkout feature/your-feature
   git fetch origin
   git rebase origin/main
   ```

3. **Verify Locally:**
   - `npm run typecheck` passes with zero errors.
   - `npm run build` (`wrangler deploy --dry-run`) completes cleanly.
4. **Use PR Template:** Pull requests automatically populate the template from [`.github/pull_request_template.md`](../.github/pull_request_template.md).
