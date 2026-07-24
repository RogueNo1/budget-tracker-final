# Ledger

A combined budget tracker: it accepts both formats from your two originals —
a bank **CSV** export (Nr / Account / Posting Date / Description / Category /
Money In / Money Out / Fee / Balance columns) and a **PDF** bank statement
(parsed in-browser with pdf.js, same rules-based auto-categorization as
before). Everything lands in one dashboard: KPIs, a spending-by-category
donut, a balance-over-time line, and a searchable/sortable transaction table.

Accounts (login) are handled by **Netlify Identity**. Transactions are
stored in **Supabase**, written through one small Netlify Function so the
database's service key never reaches the browser. A unique constraint in
the database is what actually stops duplicate transactions from being
saved — re-importing the same file, or the same statement from two
different computers, is always safe.

## How it fits together

```
browser (index.html/app.js)
   │  Authorization: Bearer <netlify identity token>
   ▼
netlify/functions/transactions.mjs   (verifies the token, no secrets in the browser)
   │  service role key (server-side only)
   ▼
Supabase (transactions table)
```

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run everything in `supabase-schema.sql` from
   this folder. That creates the `transactions` table and the unique
   index that enforces "no duplicate transactions."
3. Go to **Project Settings → API** and copy:
   - the **Project URL**
   - the **`service_role` key** (not the `anon` key — this one is secret,
     never put it in `index.html`/`app.js`)

## 2. Deploy to Netlify

1. Push this folder to a GitHub repo, then **Add new site → Import an
   existing project** in Netlify and point it at the repo.
   - Build command: leave blank
   - Publish directory: `.`
2. In **Site configuration → Environment variables**, add:
   - `SUPABASE_URL` = the project URL from step 1
   - `SUPABASE_SERVICE_ROLE_KEY` = the service role key from step 1
3. In **Site configuration → Identity**, click **Enable Identity**.
   - Under Registration, "Open" lets anyone sign up; "Invite only" if you'd
     rather add people yourself.
4. Deploy. Netlify installs `@netlify/identity` and `@supabase/supabase-js`
   from `package.json` automatically and bundles the function.

## 3. Use it

- Open the site, click **Log in / Sign up**, create an account (this is
  the Netlify Identity account — it's what scopes your data to you).
- Give the account a name (e.g. "Checking ···1234") the first time you
  import a file, or use **+ New account** to add another one later.
- Drop a CSV or PDF onto the upload zone. Both formats are auto-detected.
- Import the same file again, or a statement that overlaps a previous one
  — already-saved transactions are skipped, both instantly in the browser
  and, as a backstop, by the database itself.

## Notes and things you might want to change

- **Dedup key**: a transaction is considered "the same" if it has the same
  account, date, amount, and the first 60 characters of its description.
  If your bank re-words descriptions between exports, loosen or tighten
  this in `dedupeKey()` in `app.js`.
- **Categorization**: CSV imports use whatever category the bank already
  assigned; PDF imports run through the same keyword rules from the
  original PDF tracker (`CATEGORY_RULES` in `app.js`) — edit those patterns
  to match your own statements.
- **Multiple accounts**: the account switcher filters the whole dashboard
  (KPIs, charts, table) to one account, or shows everything combined.
- **Local development**: `netlify dev` runs the site and function together
  and reads `.env` for the two Supabase variables if you want to test
  before deploying.
