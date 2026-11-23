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
- SQL run order: `supabase/schema.sql` → `supabase/fixup.sql` → `supabase/phase3_notifications.sql` → `supabase/phase4_profiles.sql` → `supabase/phase5_scheduled_jobs.sql` (needs pg_cron)
- Supabase gotcha: if queries return 403 / `42501 permission denied`, table GRANTs to `authenticated` are missing (see fixup.sql), not RLS
- Export libs: `xlsx` comes from the SheetJS CDN tarball (not npm `xlsx`); `jspdf` + `jspdf-autotable` — all lazy-loaded
- `ENVISIONED UI/` = original Figma exports (reference only); `public/imports/` = served copies

## Spec
- `ITSO_System_Feature_Spec.md` is the authoritative feature spec (Phases 0–9)
- Open items: Google OAuth wiring, RLS testing, pg_cron reminder jobs, Resend email edge functions, GitHub Pages deploy
