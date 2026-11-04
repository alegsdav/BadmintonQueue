# Courtside Queue

Badminton court queue: Vite (vanilla JS) front end, Supabase (Postgres, Auth, Realtime), deployed on Vercel.
Winner-stays doubles, pairs or singles, admin allowlist by email.

## Run locally
    npm install
    cp .env.example .env.local     # fill in your Supabase URL + anon key
    npm run dev                    # http://localhost:5173

## Supabase (one-time)
1. Create a project, open **SQL Editor**, paste `supabase/schema.sql`, change `you@example.com` to your admin email, run it.
2. **Authentication -> Providers -> Email**: keep "Confirm email" ON.
3. **Authentication -> URL Configuration**: Site URL = your Vercel URL; add `http://localhost:5173` as a redirect URL for local dev.
4. **Project Settings -> API**: copy the Project URL and anon/publishable key into `.env.local`.

## Deploy to Vercel
Push to GitHub, then Vercel -> Add New Project -> import. Vercel detects Vite automatically (build `npm run build`, output `dist`).
Add two Environment Variables in Project Settings: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then redeploy.
(Or: `npx vercel`, then add the variables and run `npx vercel --prod`.)

## Notes
- More courts: `update settings set courts_count = 3;`
- All writes go through database functions; clients cannot edit tables directly, so admin rules hold even if someone tampers with the page.
