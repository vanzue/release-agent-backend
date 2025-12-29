# release-agent-backend

Backend + worker for the Release Notes Generator.

## Documentation

- Start here: `backend/README.md`
- Overview: `backend/overview.md`
- Feature list: `backend/features.md`
- API contract: `backend/api/README.md` (OpenAPI: `backend/api/openapi.yaml`)
- Tech stack & deployment: `backend/tech-stack.md`
- Important callouts: `backend/callouts.md`

## Quick start (local)

Prereqs:

- Node.js 20+
- pnpm 9+
- PostgreSQL (local or Azure)

Commands:

- Install: `pnpm install`
- Run migrations: `DATABASE_URL=... pnpm db:migrate`
- Run API: `pnpm --filter @release-agent/api dev`
- Run worker: `pnpm --filter @release-agent/worker dev` (requires `SERVICEBUS_CONNECTION_STRING`)

Copy env files:

- API: `apps/api/.env.example` → `apps/api/.env`
- Worker: `apps/worker/.env.example` → `apps/worker/.env`

Notes:

- The API uses PostgreSQL (`DATABASE_URL`) for releases/sessions/jobs/artifacts.
