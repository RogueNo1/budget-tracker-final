-- Run this once in the Supabase SQL editor for your project.

create table if not exists transactions (
  id           bigint generated always as identity primary key,
  user_id      text not null,        -- Netlify Identity user id (a uuid string)
  account      text not null default 'Default',
  date         date not null,
  description  text not null default '',
  category     text not null default 'Uncategorised',
  amount       numeric(12,2) not null,   -- positive = money in, negative = money out
  fee          numeric(12,2) not null default 0,
  balance      numeric(12,2),
  dedupe_key   text not null,        -- hash of account+date+amount+description
  created_at   timestamptz not null default now()
);

-- This is what actually prevents duplicate transactions: the same
-- user + account + dedupe_key can only ever exist once. The app's
-- upsert (with ignoreDuplicates) relies on this index by name.
create unique index if not exists transactions_user_account_dedupe_key
  on transactions (user_id, account, dedupe_key);

create index if not exists transactions_user_date
  on transactions (user_id, date);

-- Row Level Security is enabled, but with no policies for the anon/
-- authenticated roles. Only the Netlify Function (using the service
-- role key, which bypasses RLS entirely) can read or write rows, so
-- nothing here needs to trust a client-supplied token.
alter table transactions enable row level security;

-- User-defined custom categories (in addition to the built-in ones
-- baked into CATEGORY_RULES / CAT_COLORS in app.js). Only used to
-- populate the category picker; a transaction's category is just a
-- text column, so nothing else needs to reference this table by id.
create table if not exists categories (
  id           bigint generated always as identity primary key,
  user_id      text not null,
  name         text not null,
  created_at   timestamptz not null default now()
);

create unique index if not exists categories_user_name
  on categories (user_id, name);

alter table categories enable row level security;
