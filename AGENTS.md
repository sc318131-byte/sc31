# Repository Guidelines

## Project Structure & Scope

This project currently contains `報修需求筆記.txt`, the Traditional Chinese requirements for a small repair and issue registration demo. There are no application sources, tests, assets, dependency manifests, or build scripts yet. Read the note before implementing features.

`文件/報修欄位表.xlsx` holds the field reference (sheet 「欄位」) and ten fictional sample records with drop-down lists (sheet 「範例資料」). Items the note leaves open are marked 「待確認」.

Planned deliverables include a submission form and report list, a Supabase table with access rules, an Excel field reference with sample data, a six-slide proposal, and a Word operating guide. When adding files, group application code, database scripts, documentation, and sample data into clearly named directories, and update this guide with their actual locations.

## Build, Test, and Development Commands

No build, test, or local development commands are configured. Do not assume `npm test`, `npm run dev`, or another toolchain exists. When introducing a stack, document its prerequisites, installation steps, environment variables, and exact run commands alongside the implementation.

## Coding Style & Naming Conventions

No formatter, linter, or language-specific style has been established. Use consistent indentation and descriptive names within each introduced language; configure formatting when application code is added. Keep user-facing labels and operating instructions in Traditional Chinese. Use the requirement note’s category, urgency, and status values consistently across forms, database definitions, and examples.

## Testing Guidelines

No testing framework or coverage threshold exists. Future checks should cover required-field validation, successful submissions, list rendering, automatically generated registration timestamps, and database permissions. Include reproducible verification steps with each implementation change. Use fictional names and locations in fixtures and screenshots.

## Commit & Pull Request Guidelines

This directory currently has no Git metadata, so no historical commit convention can be inferred. When version control is introduced, use short, imperative commit subjects such as `Add report submission validation`. Pull requests should explain the change, identify affected requirements, report verification results, and include screenshots for visible interface changes.

## Security & Unresolved Requirements

Enable Supabase row-level security. The current demo permits public inserts and reads, while updates and deletes remain prohibited. Never expose privileged Supabase credentials in frontend code or committed files. Login, status-update ownership, and notifications remain undecided; clarify these before expanding access or adding those workflows.
