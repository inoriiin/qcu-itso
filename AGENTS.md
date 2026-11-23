# QCU ITSO — project notes

## Stack
- Frontend: Vite + React 18 + TypeScript (`src/`)
- Backend: Supabase (Postgres + Auth + RLS) — schema in `supabase/schema.sql`
- Supabase client: `src/lib/supabase.ts` (env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` in `.env.local`)

## Commands (use `npm.cmd` on this machine — `npm.ps1` is blocked by execution policy)
- Dev server: `npm.cmd run dev` → http://localhost:5173
- Build/typecheck: `npm.cmd run build`

## Conventions
- Brand colors: `#002366` (primary blue), `#FD7201` (accent orange) — defined in `src/index.css` / `src/enhancements.css`
- Colleges/programs per `QCU Structure.md` (5 colleges, 9 programs) — seeded in `supabase/schema.sql`
- Student ID format: `xx-xxxx` (year enrolled - unique number)
- Statuses/filing types are Postgres enums in `supabase/schema.sql` — keep `src/App.tsx` status/type lists in sync
- Live mode (signed in via Supabase) reads/writes Supabase via `src/lib/db.ts`; `localStorage` (`itso.*` keys) is only the offline fallback
- SQL run order (all already applied to the live project): `schema.sql` → `fixup.sql` → `phase3_notifications.sql` → `phase4_profiles.sql` → `phase5_scheduled_jobs.sql` (pg_cron) → `phase6_links_events.sql` → `phase7_email_cron.sql` (pg_net; secret placeholder must be filled in at run time, never committed)
- New schema changes: add a new `supabase/phaseN_*.sql` file (idempotent: `if not exists`, `drop ... if exists`); user runs it in the Supabase SQL Editor, then `notify pgrst, 'reload schema';`
- Supabase gotchas: 403 / `42501 permission denied` = missing table GRANTs (this project doesn't auto-grant; see fixup.sql — covers `authenticated` + `service_role`), not RLS. `PGRST202` function not found = migration not run or schema cache stale.
- Mutations that RLS blocks with an UPDATE matching 0 rows return no error — keep that in mind when debugging "saved but nothing changed"

## Email / scheduled jobs
- `notifications_log` is both the in-app bell feed and the email outbox (`delivery_status`: pending / sent / failed_* / skipped). Rows are created only by DB triggers/jobs; recipient = student email or `'admin'` (expanded to all active admins at send time)
- Edge Function `supabase/functions/send-notifications/index.ts` is deployed via the Supabase dashboard editor (paste + Deploy; no CLI). Verify JWT is OFF; auth is the `x-cron-secret` header
- pg_cron jobs: `itso-email-dispatch` (every 5 min → Edge Function), `itso-daily` (01:00 UTC → SER/defect reminders + 10-year auto-archive)
- Edge Function secrets: `CRON_SECRET`, `GMAIL_USER` + `GMAIL_APP_PASSWORD` (current provider — Gmail SMTP port 465), `RESEND_API_KEY` (fallback; needs a verified domain to email anyone but the signup address), optional `EMAIL_TEST_RECIPIENT` (redirects all mail), `EMAIL_FROM`, `SITE_URL`
- Local-only secret: `supabase/cron_secret.local.txt` (gitignored)

## Deployment
- GitHub repo `inoriiin/qcu-itso` (public) → `.github/workflows/deploy-pages.yml` builds and deploys on every push to `main` → https://inoriiin.github.io/qcu-itso/
- Repo secrets: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; repo variable `VITE_BASE=/qcu-itso/` (read in `vite.config.ts`; must match the repo name)
- Supabase Auth URL config must list both `http://localhost:5173/**` and the Pages URL; Google OAuth app is in Testing mode (only listed test users can sign in)
- git is not on PATH on this machine; the user commits/pushes with GitHub Desktop
- Export libs: `xlsx` comes from the SheetJS CDN tarball (not npm `xlsx`); `jspdf` + `jspdf-autotable` — all lazy-loaded
- `ENVISIONED UI/` = original Figma exports (reference only); `public/imports/` = served copies

## Spec
- `ITSO_System_Feature_Spec.md` is the authoritative feature spec (Phases 0–9)
- Status: feature-complete against the spec. Open items: QCU domain verification for Resend (DNS via QCU IT), college list decision (`QCU Structure.md` 5 colleges vs spec 4), formal RLS cross-access testing, optional Supabase Realtime instead of 60s notification polling, whitelist "add" not yet written to admin_action_log
