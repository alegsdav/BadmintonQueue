# Slugminton

Badminton court queue: Vite (vanilla JS) front end, Supabase (Postgres, Auth, Realtime), deployed on Vercel.
Winner-stays doubles, pairs or singles, admin allowlist by email.

## Run locally
    npm install
    cp .env.example .env.local     # fill in your Supabase URL + anon key
    npm run dev                    # http://localhost:5173
    npm test                       # view logic + database functions (in-memory Postgres, never the live project)

Try the board without touching real data: `npm run dev`, then open http://localhost:5173/?mock.
It runs the real schema in your browser (PGlite) with sample players, signed in as an admin.

## Supabase
The live Supabase project is what runs; `supabase/` keeps a copy of it in the repo:
- `supabase/schema.sql`: snapshot of the live database (tables, functions, security), taken 2026-11-06.
- `supabase/migrations/`: changes made after that snapshot, run in filename order in **SQL Editor**.

When you change a function in the dashboard, add a migration file here too so the repo stays in step.
New project from scratch: run `schema.sql` (change `you@example.com` to your email first), then each migration.

1. **Authentication -> Providers -> Email**: keep "Confirm email" ON.
2. **Authentication -> URL Configuration**: Site URL = your Vercel URL; add `http://localhost:5173` as a redirect URL for local dev.
3. **Project Settings -> API**: copy the Project URL and anon/publishable key into `.env.local`.

## Deploy to Vercel
Push to GitHub, then Vercel -> Add New Project -> import. Vercel detects Vite automatically (build `npm run build`, output `dist`).
Add two Environment Variables in Project Settings: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then redeploy.
(Or: `npx vercel`, then add the variables and run `npx vercel --prod`.)

## How it plays
- Every court has its own queue. Tap a court, then the button: you take an open spot, or join the end of that court's queue.
- Tap **Invite** and search for a teammate, or tap a single player in a doubles queue to invite them directly. Both players must be unpaired and off court, and cannot be waiting for singles. The recipient accepts or declines in the banner at the top of the board. If several invitations are pending, use the banner arrows to move between them. Senders can cancel a pending invitation from the **Invite** dialog. A pending invitation holds no spot.
- Accepting an invite shows **Teammate: [name]** at the top of the board. The pair starts off court and out of the queues, giving up any individual queue spots. Either partner can then choose a doubles court to join or queue together, or select **Leave team** before signing up.
- Winners stay on, but a team that has played 3 straight matches comes off after the 3rd even if it wins (the losers stay). Players on that court, or admins, report the result.

## Admins
- Who is an admin: anyone whose confirmed sign-in email is in the `admin_emails` table.
  Add or remove them in the app (**Admin -> Settings**), or in the dashboard (Table Editor -> `admin_emails`).
- **Admin** in the header turns on admin mode. Drag a player on court, or a spot in line:
  - onto a side with room: they go there (a player leaves their partner; a team in line moves together)
  - onto another player: the two swap places, on court or in line
  - into a court's queue: dropped just ahead of the row you let go on, or at the end
  - into the bin that appears at the bottom: removed
- On a phone, press and hold a name before dragging; a quick swipe still scrolls.
- Admins can still tap any live court to report its result, and toggle "Losers rejoin the queue" in Settings.

## Settings (Supabase dashboard, table `settings`)
- More courts: `courts_count`.
- Singles courts: `singles_courts` holds the court indexes (0 = Court 1) that play singles, e.g. `{1}` for Court 2.
- Winner cap: `win_cap` (default 3).
- Losers rejoin their court's queue: `loser_back`.
- All writes go through database functions; clients cannot edit tables directly, so the rules hold even if someone tampers with the page.
