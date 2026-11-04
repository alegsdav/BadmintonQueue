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
- Players can join a specific court and choose a side, or join the general queue. Court invites can target an available court and side and place both players there after acceptance. For existing Supabase projects, run the migration files in `supabase/migrations/` in filename order in the SQL Editor.
- Pairs can leave together, and admins can remove a whole pair from its spot. Admins can also toggle whether losing players rejoin the queue.
- Admins can pair two single players and move them together to a court with room for a pair or to the end of the queue.
- When loser rejoin is enabled and no one is already waiting, the losing entry stays in the queue so its members can choose an open side together. Court selection is only available to the first queue entry and requires enough room for the entire entry.
- All writes go through database functions; clients cannot edit tables directly, so admin rules hold even if someone tampers with the page.
