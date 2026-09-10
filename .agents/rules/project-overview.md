# Project Overview: invoice-rescue

## Stack Architecture
- **Backend**: Cloudflare Worker (`backend/src/index.ts`, TypeScript) + Cloudflare D1 Database.
- **Frontend**: Static assets located in `frontend/` deployed with Worker asset bindings.
- **Specification & Documentation**: See `docs/architecture.md` and `invoice-rescue-build-plan.md`.

## Engineering Guidelines
1. **Cloudflare Worker Runtime**:
   - Built on standard Web Platform APIs (`fetch`, `Request`, `Response`, `Web Crypto`).
   - Do not import Node.js built-ins (`fs`, `child_process`, `net`) that are incompatible with Workers runtime.
2. **Cloudflare D1 Database**:
   - Access via `env.DB`.
   - All queries must be strictly parameterized (`env.DB.prepare("...").bind(...)`). Never string-concatenate user input into SQL statements.
3. **Frontend Assets**:
   - Keep assets modular, clean, and responsive.
   - Follow accessibility standards (WCAG 2.2 AA) for forms and interactive elements.
4. **Environment & Secrets**:
   - Local secrets belong in `.dev.vars` (never committed).
   - Production secrets configured via Cloudflare dashboard or `wrangler secret put`.
