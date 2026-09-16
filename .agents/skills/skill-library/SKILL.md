---
name: skill-library
description: "Search and route to archived ECC skills, agents, rules, and workflows stored in .agents/_disabled/. Use when you need off-stack reference material, alternative language idioms, or niche workflow capabilities without loading them into the active session by default."
metadata:
  origin: ECC
---

# Skill Library Router

This repository (`invoice-rescue`) uses an evidence-backed **DAILY vs LIBRARY** classification model established by `/agent-sort`.

- **DAILY (Active)**: Components matching the active TypeScript, Node.js, Cloudflare Workers, Cloudflare D1, Stripe, and HTML/CSS web stack. These load automatically into every session.
- **LIBRARY (Archived in `_disabled/`)**: Components retained for reference or future multi-stack tasks, but kept disabled to prevent context budget exhaustion.

---

## Library Locations

All library components are preserved in `.agents/_disabled/`:

- **Agents**: `.agents/_disabled/agents/`
- **Rules**: `.agents/_disabled/rules/`
- **Skills**: `.agents/_disabled/skills/`
- **Workflows**: `.agents/_disabled/workflows/`

---

## Grouped Index & Trigger Keywords

| Category | Available Archived Capabilities | Location |
|---|---|---|
| **Python & Data Science** | `python-*`, `django-*`, `fastapi-*`, `pytorch-*`, `mle-*` | `_disabled/skills/`, `_disabled/agents/` |
| **JVM Ecosystem** | `java-*`, `springboot-*`, `quarkus-*`, `kotlin-*`, `gradle-*` | `_disabled/skills/`, `_disabled/agents/` |
| **Systems & Native** | `cpp-*`, `rust-*`, `golang-*`, `go-*`, `csharp-*`, `dotnet-*`, `fsharp-*` | `_disabled/skills/`, `_disabled/agents/` |
| **Mobile & Cross-Platform**| `flutter-*`, `dart-*`, `swift-*`, `react-native-*`, `harmonyos-*` | `_disabled/skills/`, `_disabled/agents/` |
| **Alternative Web Frameworks**| `react-*`, `vue-*`, `angular-*`, `rails-*`, `ruby-*`, `laravel-*`, `php-*`, `svelte-*`, `tinystruct-*` | `_disabled/skills/`, `_disabled/agents/` |
| **Network & Infrastructure** | `network-architect`, `network-config-reviewer`, `network-troubleshooter`, `homelab-architect` | `_disabled/agents/` |
| **React Motion & UI Frameworks**| `motion-advanced`, `motion-foundations`, `motion-patterns`, `motion-ui`, `frontend-patterns`, `frontend-a11y` | `_disabled/skills/` |
| **Multi-Model Orchestration** | `multi-backend`, `multi-execute`, `multi-frontend`, `multi-plan`, `multi-workflow`, `council`, `ruflo` | `_disabled/skills/` |
| **Autonomous Loops & GANs** | `loop-start`, `loop-status`, `loop-design-check`, `gan-build`, `gan-design`, `santa-loop`, `santa-method` | `_disabled/skills/` |
| **Epic & PRP Coordination** | `epic-claim`, `epic-decompose`, `epic-publish`, `epic-review`, `epic-sync`, `prp-*`, `orch-*` | `_disabled/skills/` |
| **Skill & Config Meta-Tooling** | `skill-stocktake`, `skill-comply`, `skill-health`, `skill-scout`, `config-gc`, `context-budget`, `plankton-*` | `_disabled/skills/` |
| **External Trackers & Architecture** | `jira`, `continuous-learning`, `council-multi-model`, `setup-pm`, `hexagonal-architecture` | `_disabled/skills/` |

---

## How to Retrieve or Restore a Library Component

1. **Reference on demand**:
   Read the archived skill directly using `view_file`:
   ```markdown
   view_file(AbsolutePath: "d:/Dev/Workspaces/Active/invoice-rescue/.agents/_disabled/skills/<skill-name>/SKILL.md")
   ```
2. **Promote to DAILY**:
   If the repository adopts a new language or framework, move the component from `.agents/_disabled/<type>/` back to `.agents/<type>/` and run `/verification-loop` to verify.

