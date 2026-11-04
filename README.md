# Badminton Queue (Supabase + Vercel)

Static front end on Vercel, Postgres + Auth + Realtime on Supabase. No server code and no build step.

## 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor** -> paste `supabase/schema.sql`, change `you@example.com` to your admin email, and run it (fresh project, run once).
3. **Authentication -> Providers -> Email**: keep "Confirm email" ON (this is what makes the admin email allowlist trustworthy).
4. **Authentication -> URL Configuration**: set Site URL to your Vercel URL (add `http://localhost:3000` as an extra redirect for local testing).
5. **Project Settings -> API**: copy the Project URL and anon public key into `config.js`.

## 2. Vercel
Push this folder to GitHub -> Vercel "Add New Project" -> import it (Framework Preset: Other, no build command, output directory blank).
Or from the folder: `npx vercel --prod`. Local test: `npx serve .`

## Notes
- Admins = confirmed accounts whose email is in the `admin_emails` table (manage on the Admin tab or in the Table Editor).
- Number of courts: `update settings set courts_count = 3;`
- Every change goes through database functions; clients cannot write tables directly.
