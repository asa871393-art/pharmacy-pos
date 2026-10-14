-- Pharmacy POS — cloud side of the sync (see src-tauri/src/sync.rs).
--
-- Setup, once per pharmacy:
--   1. In your Supabase project open SQL Editor, paste this whole file and run it. Running it again is safe.
--   2. Choose a sync secret (a long random phrase) and store its fingerprint by running, with your phrase:
--        insert into pos.config(key, value)
--        values ('secret_sha256', encode(sha256(convert_to('YOUR-SYNC-SECRET', 'UTF8')), 'hex'))
--        on conflict (key) do update set value = excluded.value;
--   3. In the app (admin → Employees → Cloud sync) enter the project URL, the anon (public) API key from
--      Project Settings → API, and the same sync secret.
--
-- How it fits together: every till keeps its own SQLite database and works with no internet. Each till pushes its
-- outbox (sales, purchases, stock corrections, product edits, audit entries) through pos_sync_push, and pulls the
-- catalog and every batch's stock through pos_sync_pull. The tables live in the private `pos` schema, which the REST
-- API does not expose; tills reach them only through the two functions, and only with the sync secret.
-- The cloud owns the catalog: the last product edit to arrive wins and every till takes it on its next pull.
-- Stock is never overwritten: a batch's quantity is the sum of all tills' movements.

create schema if not exists pos;
revoke all on schema pos from public, anon, authenticated;

-- Every catalog or stock change takes the next revision; a till pulls the revisions after the last one it saw.
create sequence if not exists pos.rev;

create table if not exists pos.config (
  key   text primary key,
  value text not null
);

create table if not exists pos.devices (
  id         text primary key,
  name       text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

-- Outbox entries already applied: a till that resends after a dropped connection changes nothing.
create table if not exists pos.applied (
  entry_id   text primary key,
  device_id  text not null,
  kind       text not null,
  applied_at timestamptz not null default now()
);

create table if not exists pos.categories (
  id  text primary key,
  doc jsonb not null,
  rev bigint not null default nextval('pos.rev')
);

create table if not exists pos.products (
  id         text primary key,
  doc        jsonb not null,               -- the till's products row
  barcodes   jsonb not null default '[]',  -- product_barcodes rows
  reorder    jsonb not null default '[]',  -- reorder_rules rows
  rev        bigint not null default nextval('pos.rev'),
  updated_at timestamptz not null default now(),
  updated_by text                          -- device id
);

create table if not exists pos.batches (
  id         text primary key,
  product_id text not null,
  doc        jsonb not null,               -- the till's batches row, without qty_on_hand
  rev        bigint not null default nextval('pos.rev')
);

create table if not exists pos.movements (
  id          text primary key,
  batch_id    text not null,
  qty         integer not null,            -- signed: + in, − out
  doc         jsonb not null,
  device_id   text not null,
  rev         bigint not null default nextval('pos.rev'),
  received_at timestamptz not null default now()
);

create table if not exists pos.sales (
  id         text primary key,
  invoice_no text not null,
  device_id  text not null,
  created_at text not null,
  total      bigint not null,
  doc        jsonb not null                -- sale, items, payments, prescription, movements
);

create table if not exists pos.purchases (
  id        text primary key,
  device_id text not null,
  doc       jsonb not null
);

-- Each till's own hash-chained audit log, copied entry by entry.
create table if not exists pos.audit_log (
  device_id   text not null,
  seq         bigint not null,
  action      text not null,
  occurred_at text not null,
  doc         jsonb not null,
  primary key (device_id, seq)
);

create index if not exists categories_rev on pos.categories(rev);
create index if not exists products_rev on pos.products(rev);
create index if not exists batches_rev on pos.batches(rev);
create index if not exists movements_rev on pos.movements(rev);
create index if not exists movements_batch on pos.movements(batch_id);
create index if not exists sales_created on pos.sales(created_at);

-- No policies: nobody reads or writes these tables directly, only through the functions below.
alter table pos.config enable row level security;
alter table pos.devices enable row level security;
alter table pos.applied enable row level security;
alter table pos.categories enable row level security;
alter table pos.products enable row level security;
alter table pos.batches enable row level security;
alter table pos.movements enable row level security;
alter table pos.sales enable row level security;
alter table pos.purchases enable row level security;
alter table pos.audit_log enable row level security;
revoke all on all tables in schema pos from public, anon, authenticated;
revoke all on all sequences in schema pos from public, anon, authenticated;

create or replace function pos.check_secret(p_secret text) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_secret is null or not exists (
    select 1 from pos.config
    where key = 'secret_sha256' and value = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
  ) then
    raise exception 'sync secret is wrong or not set' using errcode = '28000';
  end if;
end $$;

-- Applies one outbox entry. Payload shapes: product_payload, sale_payload, purchase_payload and movement_payload in
-- sync.rs, and {"entries": [audit rows]} for AUDIT_LOG.
create or replace function pos.apply_entry(p_device text, p_kind text, p jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  x jsonb;
begin
  if p_kind = 'UPDATE_PRODUCT' then
    if jsonb_typeof(p->'product') <> 'object' then
      raise exception 'UPDATE_PRODUCT without a product';
    end if;
    if jsonb_typeof(p->'category') = 'object' then
      insert into pos.categories(id, doc) values (p->'category'->>'id', p->'category')
      on conflict (id) do update set doc = excluded.doc, rev = nextval('pos.rev')
      where pos.categories.doc is distinct from excluded.doc;
    end if;
    insert into pos.products(id, doc, barcodes, reorder, updated_by)
    values (p->'product'->>'id', p->'product', coalesce(p->'barcodes', '[]'), coalesce(p->'reorder', '[]'), p_device)
    on conflict (id) do update
      set doc = excluded.doc, barcodes = excluded.barcodes, reorder = excluded.reorder,
          updated_by = excluded.updated_by, updated_at = now(), rev = nextval('pos.rev');

  elsif p_kind = 'AUDIT_LOG' then
    for x in select value from jsonb_array_elements(coalesce(p->'entries', '[]')) loop
      insert into pos.audit_log(device_id, seq, action, occurred_at, doc)
      values (p_device, (x->>'seq')::bigint, x->>'action', x->>'occurred_at', x)
      on conflict do nothing;
    end loop;

  elsif p_kind in ('POST_SALE', 'ADD_PURCHASE', 'STOCK_ADJUST') then
    for x in select value from jsonb_array_elements(coalesce(p->'batches', '[]')) loop
      insert into pos.batches(id, product_id, doc) values (x->>'id', x->>'product_id', x - 'qty_on_hand')
      on conflict (id) do update set doc = excluded.doc, rev = nextval('pos.rev')
      where pos.batches.doc is distinct from excluded.doc;
    end loop;
    for x in select value from jsonb_array_elements(coalesce(p->'movements', '[]')) loop
      insert into pos.movements(id, batch_id, qty, doc, device_id)
      values (x->>'id', x->>'batch_id', (x->>'qty')::integer, x, p_device)
      on conflict (id) do nothing;
    end loop;
    if p_kind = 'POST_SALE' then
      insert into pos.sales(id, invoice_no, device_id, created_at, total, doc)
      values (p->'sale'->>'id', p->'sale'->>'invoice_no', p_device, p->'sale'->>'created_at', (p->'sale'->>'total')::bigint, p)
      on conflict (id) do nothing;
    elsif p_kind = 'ADD_PURCHASE' and jsonb_typeof(p->'invoice') = 'object' then
      insert into pos.purchases(id, device_id, doc) values (p->'invoice'->>'id', p_device, p)
      on conflict (id) do nothing;
    end if;

  else
    raise exception 'unknown entry kind %', p_kind;
  end if;
end $$;

-- Applies a batch of outbox entries from one till. Each entry is applied on its own: one that fails is reported
-- back in "failed" (the till retries it later) and does not stop the others.
create or replace function public.pos_sync_push(p_secret text, p_device jsonb, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  v_device text := nullif(p_device->>'id', '');
  v_applied integer := 0;
  v_failed jsonb := '[]';
begin
  perform pos.check_secret(p_secret);
  if v_device is null then
    raise exception 'device id missing';
  end if;
  insert into pos.devices(id, name) values (v_device, p_device->>'name')
  on conflict (id) do update set name = excluded.name, last_seen = now();

  for e in select value from jsonb_array_elements(coalesce(p_entries, '[]')) loop
    continue when exists (select 1 from pos.applied where entry_id = e->>'id');
    begin
      perform pos.apply_entry(v_device, e->>'kind', e->'payload');
      insert into pos.applied(entry_id, device_id, kind) values (e->>'id', v_device, e->>'kind');
      v_applied := v_applied + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', e->>'id', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'failed', v_failed);
end $$;

-- Catalog and stock changed after revision p_since (0 = everything). One snapshot (stable), so the cursor matches
-- the rows returned.
create or replace function public.pos_sync_pull(p_secret text, p_since bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cursor bigint;
begin
  perform pos.check_secret(p_secret);
  select greatest(
    coalesce(p_since, 0),
    coalesce((select max(rev) from pos.categories), 0),
    coalesce((select max(rev) from pos.products), 0),
    coalesce((select max(rev) from pos.batches), 0),
    coalesce((select max(rev) from pos.movements), 0)
  ) into v_cursor;

  return jsonb_build_object(
    'cursor', v_cursor,
    'categories', coalesce((
      select jsonb_agg(c.doc order by c.rev) from pos.categories c where c.rev > p_since
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('doc', p.doc, 'barcodes', p.barcodes, 'reorder', p.reorder) order by p.rev)
      from pos.products p where p.rev > p_since
    ), '[]'::jsonb),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'doc', b.doc,
        'qty', coalesce((select sum(m.qty) from pos.movements m where m.batch_id = b.id), 0)
      ))
      from pos.batches b
      where b.rev > p_since
         or exists (select 1 from pos.movements m where m.batch_id = b.id and m.rev > p_since)
    ), '[]'::jsonb)
  );
end $$;

revoke execute on all functions in schema pos from public, anon, authenticated;
revoke execute on function public.pos_sync_push(text, jsonb, jsonb) from public;
revoke execute on function public.pos_sync_pull(text, bigint) from public;
grant execute on function public.pos_sync_push(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.pos_sync_pull(text, bigint) to anon, authenticated;
