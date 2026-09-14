# ECC Rules Library (Non-Daily)

This directory contains ECC rules that are preserved for reference but excluded from daily active loading to optimize agent token budget and prevent language-pattern contamination.

## Classification Rationale (agent-sort)

The `invoice-rescue` repository stack is strictly:
- **Runtime / API**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: Vanilla HTML5 / CSS (served via Cloudflare static assets)
- **CI / Workflows**: GitHub Actions

### Preserved in Library:
- Angular, ArkTS, C++, C#, Dart/Flutter, F#, Golang, Java/Spring, Kotlin, Nuxt, Perl, PHP, Python/Django/FastAPI, React Native, Ruby/Rails, Rust, Swift, Vue.

### Active in Daily:
- `common-*`: Universal engineering, testing, security, git, and code review standards.
- `typescript-*`: TypeScript strict type safety, patterns, testing, and hooks.
- `web-*`: Web standards, performance, accessibility, security, and design quality.
- `saas-reliability.md`: SaaS operational uptime and data resilience.
- `github-workflows.md`: GitHub Actions CI/CD standards.
- `project-overview.md`: Repository layout and constraints.
