# Slugminton

Badminton court queue: Vite (vanilla JS) front end, Supabase (Postgres, Auth, Realtime), deployed on Vercel.
Winner-stays doubles, pairs or singles, admin allowlist by email.

## Run locally
    npm install
    cp .env.example .env.local     # fill in your Supabase URL + anon key
    npm run dev                    # http://localhost:5173

## Supabase
The database schema and functions live only in the Supabase project; this repo holds no SQL.
Make database changes in the Supabase dashboard (SQL Editor).

1. **Authentication -> Providers -> Email**: keep "Confirm email" ON.
2. **Authentication -> URL Configuration**: Site URL = your Vercel URL; add `http://localhost:5173` as a redirect URL for local dev.
3. **Project Settings -> API**: copy the Project URL and anon/publishable key into `.env.local`.

## Deploy to Vercel
Push to GitHub, then Vercel -> Add New Project -> import. Vercel detects Vite automatically (build `npm run build`, output `dist`).
Add two Environment Variables in Project Settings: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then redeploy.
(Or: `npx vercel`, then add the variables and run `npx vercel --prod`.)

## How it plays
- Every court has its own queue. Tap a court, then the button: you take an open spot, or join the end of that court's queue.
- Tap a single player in a queue to team up with them. The pair keeps whichever partner's spot was further ahead; if the pair splits while waiting, the partner who joined goes to the end of the line.
- Winners stay on, but a team that has played 3 straight matches comes off after the 3rd even if it wins (the losers stay). Players on that court, or admins, report the result.
- When you move from a queue onto a court, the screen turns green: "You're up, baddie!"

## Settings (Supabase dashboard, table `settings`)
- More courts: `courts_count`.
- Singles courts: `singles_courts` holds the court indexes (0 = Court 1) that play singles, e.g. `{1}` for Court 2.
- Winner cap: `win_cap` (default 3).
- Losers rejoin their court's queue: `loser_back`.
- Admins: add their email to the `admin_emails` table.
- All writes go through database functions; clients cannot edit tables directly, so the rules hold even if someone tampers with the page.
