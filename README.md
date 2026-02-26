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
- API access control validates users against PowerToys `COMMUNITY.md`.
  Public paths: `/healthz`, `/docs/*`, `/openapi.yaml`, `/auth/github/start`, `/auth/github/callback`.
  Config:
  `ACCESS_CONTROL_ENABLED=true|false` (default `true`)
  `ACCESS_CONTROL_COMMUNITY_DOC_URL=https://raw.githubusercontent.com/microsoft/PowerToys/main/COMMUNITY.md`
  `ACCESS_CONTROL_EXTRA_LOGINS=comma,separated,github,logins`
  `GITHUB_OAUTH_CLIENT_ID`
  `GITHUB_OAUTH_CLIENT_SECRET`
  `AUTH_APP_TOKEN_SECRET`
  `AUTH_FRONTEND_BASE_URL`
