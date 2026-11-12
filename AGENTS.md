# Repository Guidelines

## Project Structure & Scope

This project currently contains `報修需求筆記.txt`, the Traditional Chinese requirements for a small repair and issue registration demo. There are no application sources, tests, assets, dependency manifests, or build scripts yet. Read the note before implementing features.

`文件/報修欄位表.xlsx` holds the field reference (sheet 「欄位」) and ten fictional sample records with drop-down lists (sheet 「範例資料」). Items the note leaves open are marked 「待確認」.

`supabase/schema.sql` creates the `repair_requests` table with column grants, RLS policies, and CHECK constraints. Run it once in the Supabase SQL Editor of a fresh project; it has not been executed from this repository.

The web front end lives at the repository root: `index.html` (form and list), `style.css` (mobile-first layout), `app.js` (validation, insert without `status`, newest 20 records), and `config.js` (public Supabase URL and publishable key only; never a secret or service_role key). supabase-js v2 is pinned to 2.45.4 from jsDelivr. GitHub Pages serves `index.html` from the `main` branch root.

The chairman schedule system is a public, read-only calendar with no login (the owner chose this; do not add write access from the web page without asking):
- `schedule.html`, `schedule.js`, `schedule.css`: FullCalendar 6.1.15 calendar (jsDelivr) with a read-only detail dialog; phones open in list view.
- `supabase/schedule.sql`: `chairman_events`. anon may select only `id, title, start_at, end_at, location, note, status, report`; there are no insert, update, or delete grants or policies. Schedules are edited in the Supabase Table Editor. `reminded_at` is written only by `service_role`.
- `supabase/schedule-public-read.sql`: one-time migration for projects that ran the earlier login-based `schedule.sql`.
- `supabase/functions/line-reminder/index.ts`: Edge Function (deploy with JWT verification off) that pushes LINE Messaging API reminders to one admin; it authenticates callers with the `x-cron-secret` header.
- `supabase/cron.sql`: pg_cron job calling the function every 5 minutes, with URL and secret read from Vault. Replace its placeholders only in the SQL Editor, never in the committed file.
- `文件/行程系統設定說明.md`: Traditional Chinese setup guide (LINE channel, accounts, secrets, deployment, troubleshooting).

Both pages are installable PWAs:
- `manifest-repair.webmanifest` (start `./`) and `manifest-schedule.webmanifest` (start `./schedule.html`) with distinct `id`s, so each installs as its own app. Icons are in `icons/` (192, 512, maskable 512, Apple 180).
- `sw.js` (scope `./`): network-first for same-origin files, cache-first for the pinned jsDelivr libraries, and never caches Supabase traffic, so chairman schedule data is not stored on devices. Bump `CACHE_VERSION` when the precache list changes.
- `pwa.js`: registers the service worker, shows the 「安裝 App」 button on `beforeinstallprompt`, and shows an add-to-home-screen tip on iOS.

Planned deliverables include a submission form and report list, a Supabase table with access rules, an Excel field reference with sample data, a six-slide proposal, and a Word operating guide. When adding files, group application code, database scripts, documentation, and sample data into clearly named directories, and update this guide with their actual locations.

## Build, Test, and Development Commands

There is no build step. To preview the front end locally, run `python3 -m http.server 8000` in the repository root and open `http://localhost:8000/`; it talks to the Supabase project in `config.js`. No test runner is configured. Do not assume `npm test`, `npm run dev`, or another toolchain exists. When introducing a stack, document its prerequisites, installation steps, environment variables, and exact run commands alongside the implementation.

## Coding Style & Naming Conventions

No formatter, linter, or language-specific style has been established. Use consistent indentation and descriptive names within each introduced language; configure formatting when application code is added. Keep user-facing labels and operating instructions in Traditional Chinese. Use the requirement note’s category, urgency, and status values consistently across forms, database definitions, and examples.

## Testing Guidelines

No testing framework or coverage threshold exists. Future checks should cover required-field validation, successful submissions, list rendering, automatically generated registration timestamps, and database permissions. Include reproducible verification steps with each implementation change. Use fictional names and locations in fixtures and screenshots.

## Commit & Pull Request Guidelines

This directory currently has no Git metadata, so no historical commit convention can be inferred. When version control is introduced, use short, imperative commit subjects such as `Add report submission validation`. Pull requests should explain the change, identify affected requirements, report verification results, and include screenshots for visible interface changes.

## Security & Unresolved Requirements

Enable Supabase row-level security. The current demo permits public inserts and reads, while updates and deletes remain prohibited. Never expose privileged Supabase credentials in frontend code or committed files. For the repair demo, login, status-update ownership, and notifications remain undecided; clarify these before expanding its access. The chairman schedule is publicly readable without login, is edited only in the Supabase dashboard, and sends LINE reminders to a single admin. LINE tokens, `CRON_SECRET`, and the service_role key live only in Supabase secrets or Vault.
