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
-- outbox (sales, purchases, stock corrections, transfers, product and branch edits, audit entries) through
-- pos_sync_push, pulls the branches, catalog, transfers and every batch's stock through pos_sync_pull, and other tills'
-- sales (for reports across branches) through pos_sync_pull_sales. The tables live in the private `pos` schema, which
-- the REST API does not expose; tills reach them only through these functions, and only with the sync secret.
-- The cloud owns the catalog: the last product edit to arrive wins and every till takes it on its next pull.
-- Stock is never overwritten: a batch's quantity is the sum of all tills' movements.
-- Branches: every till works for one branch and every outbox entry names it. An entry may only touch that branch's
-- batches (a transfer: the two branches it connects); anything else is refused and stays in the till's outbox.
-- Upgrading from the single-branch version: run this whole file again. Existing rows are kept.

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
alter table pos.devices add column if not exists branch_id text;   -- the branch the till worked for at its last push

create table if not exists pos.branches (
  id  text primary key,
  doc jsonb not null,                      -- the till's branches row
  rev bigint not null default nextval('pos.rev')
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
alter table pos.movements add column if not exists branch_id text;  -- the batch's branch

create table if not exists pos.sales (
  id         text primary key,
  invoice_no text not null,
  device_id  text not null,
  created_at text not null,
  total      bigint not null,
  doc        jsonb not null                -- sale, items, payments, prescription, movements
);
alter table pos.sales add column if not exists branch_id text;
alter table pos.sales add column if not exists rev bigint not null default nextval('pos.rev');

create table if not exists pos.purchases (
  id        text primary key,
  device_id text not null,
  doc       jsonb not null
);
alter table pos.purchases add column if not exists branch_id text;

-- Stock transfers between branches; status only moves forward: requested → shipped → received, or requested → cancelled.
create table if not exists pos.transfers (
  id             text primary key,
  status         text not null,
  from_branch_id text not null,
  to_branch_id   text not null,
  doc            jsonb not null,           -- the till's stock_transfers row
  items          jsonb not null default '[]',
  rev            bigint not null default nextval('pos.rev')
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

create index if not exists branches_rev on pos.branches(rev);
create index if not exists transfers_rev on pos.transfers(rev);
create index if not exists sales_rev on pos.sales(rev);
create index if not exists sales_branch on pos.sales(branch_id, created_at);
create index if not exists categories_rev on pos.categories(rev);
create index if not exists products_rev on pos.products(rev);
create index if not exists batches_rev on pos.batches(rev);
create index if not exists movements_rev on pos.movements(rev);
create index if not exists movements_batch on pos.movements(batch_id);
create index if not exists sales_created on pos.sales(created_at);

-- No policies: nobody reads or writes these tables directly, only through the functions below.
alter table pos.config enable row level security;
alter table pos.devices enable row level security;
alter table pos.branches enable row level security;
alter table pos.transfers enable row level security;
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

drop function if exists pos.apply_entry(text, text, jsonb);

-- Applies one outbox entry. Payload shapes: product_payload, sale_payload, purchase_payload, movement_payload,
-- branch_payload and transfer_payload in sync.rs, and {"entries": [audit rows]} for AUDIT_LOG. p_branch is the branch
-- the till worked for when it wrote the entry (null from tills older than branches: not checked).
create or replace function pos.apply_entry(p_device text, p_kind text, p jsonb, p_branch text) returns void
language plpgsql set search_path = '' as $$
declare
  x jsonb;
  v_old_status text;
  v_old jsonb;
  v_status text;
begin
  if p_branch is not null and p_kind <> 'UPSERT_BRANCH' and not exists (select 1 from pos.branches where id = p_branch) then
    raise exception 'unknown branch %', p_branch;
  end if;

  if p_kind = 'UPSERT_BRANCH' then
    if jsonb_typeof(p->'branch') <> 'object' then
      raise exception 'UPSERT_BRANCH without a branch';
    end if;
    insert into pos.branches(id, doc) values (p->'branch'->>'id', p->'branch')
    on conflict (id) do update set doc = excluded.doc, rev = nextval('pos.rev')
    where pos.branches.doc is distinct from excluded.doc;

  elsif p_kind = 'UPDATE_PRODUCT' then
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

  elsif p_kind in ('POST_SALE', 'ADD_PURCHASE', 'STOCK_ADJUST', 'TRANSFER') then
    if p_kind = 'TRANSFER' then
      if jsonb_typeof(p->'transfer') <> 'object' then
        raise exception 'TRANSFER without a transfer';
      end if;
      if p_branch is not null
         and p_branch not in (p->'transfer'->>'from_branch_id', p->'transfer'->>'to_branch_id') then
        raise exception 'transfer % does not involve branch %', p->'transfer'->>'transfer_no', p_branch;
      end if;
      v_status := p->'transfer'->>'status';
      select t.status, t.doc into v_old_status, v_old from pos.transfers t where t.id = p->'transfer'->>'id';
      if v_old_status is not null then
        if v_old_status = v_status then
          -- The same step done again on another till (two tills received one shipment) would count its stock twice.
          if v_old->>'shipped_at' is distinct from p->'transfer'->>'shipped_at'
             or v_old->>'received_at' is distinct from p->'transfer'->>'received_at' then
            raise exception 'transfer % was already % on another device', p->'transfer'->>'transfer_no', v_status;
          end if;
        elsif not ((v_old_status = 'requested' and v_status in ('shipped', 'cancelled'))
                   or (v_old_status = 'shipped' and v_status = 'received')) then
          raise exception 'transfer % is already %', p->'transfer'->>'transfer_no', v_old_status;
        end if;
      end if;
      if exists (select 1 from jsonb_array_elements(coalesce(p->'batches', '[]')) b
                 where b.value->>'branch_id' not in (p->'transfer'->>'from_branch_id', p->'transfer'->>'to_branch_id')) then
        raise exception 'transfer % touches a third branch''s stock', p->'transfer'->>'transfer_no';
      end if;
    elsif p_branch is not null then
      if exists (select 1 from jsonb_array_elements(coalesce(p->'batches', '[]')) b
                 where b.value->>'branch_id' is distinct from p_branch) then
        raise exception 'an entry of branch % touches another branch''s stock', p_branch;
      end if;
      if p_kind = 'POST_SALE' and p->'sale'->>'branch_id' is distinct from p_branch then
        raise exception 'sale % belongs to another branch', p->'sale'->>'invoice_no';
      end if;
    end if;

    for x in select value from jsonb_array_elements(coalesce(p->'batches', '[]')) loop
      insert into pos.batches(id, product_id, doc) values (x->>'id', x->>'product_id', x - 'qty_on_hand')
      on conflict (id) do update set doc = excluded.doc, rev = nextval('pos.rev')
      where pos.batches.doc is distinct from excluded.doc;
    end loop;
    for x in select value from jsonb_array_elements(coalesce(p->'movements', '[]')) loop
      insert into pos.movements(id, batch_id, qty, doc, device_id, branch_id)
      values (x->>'id', x->>'batch_id', (x->>'qty')::integer, x, p_device,
              (select b.doc->>'branch_id' from pos.batches b where b.id = x->>'batch_id'))
      on conflict (id) do nothing;
    end loop;
    if p_kind = 'POST_SALE' then
      insert into pos.sales(id, invoice_no, device_id, created_at, total, doc, branch_id)
      values (p->'sale'->>'id', p->'sale'->>'invoice_no', p_device, p->'sale'->>'created_at', (p->'sale'->>'total')::bigint, p,
              p->'sale'->>'branch_id')
      on conflict (id) do nothing;
    elsif p_kind = 'ADD_PURCHASE' and jsonb_typeof(p->'invoice') = 'object' then
      insert into pos.purchases(id, device_id, doc, branch_id) values (p->'invoice'->>'id', p_device, p, p->'invoice'->>'branch_id')
      on conflict (id) do nothing;
    elsif p_kind = 'TRANSFER' then
      insert into pos.transfers(id, status, from_branch_id, to_branch_id, doc, items)
      values (p->'transfer'->>'id', v_status, p->'transfer'->>'from_branch_id', p->'transfer'->>'to_branch_id',
              p->'transfer', coalesce(p->'items', '[]'))
      on conflict (id) do update set status = excluded.status, doc = excluded.doc, items = excluded.items,
                                     rev = nextval('pos.rev')
      where pos.transfers.doc is distinct from excluded.doc or pos.transfers.items is distinct from excluded.items;
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
  insert into pos.devices(id, name, branch_id) values (v_device, p_device->>'name', nullif(p_device->>'branch_id', ''))
  on conflict (id) do update set name = excluded.name, branch_id = excluded.branch_id, last_seen = now();

  for e in select value from jsonb_array_elements(coalesce(p_entries, '[]')) loop
    continue when exists (select 1 from pos.applied where entry_id = e->>'id');
    begin
      perform pos.apply_entry(v_device, e->>'kind', e->'payload', nullif(e->>'branch_id', ''));
      insert into pos.applied(entry_id, device_id, kind) values (e->>'id', v_device, e->>'kind');
      v_applied := v_applied + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', e->>'id', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'failed', v_failed);
end $$;

-- Branches, catalog, transfers and stock changed after revision p_since (0 = everything). One snapshot (stable), so the
-- cursor matches the rows returned. Every branch's batches come down: a till shows only its own branch's stock, but
-- reports and transfers look at the others.
create or replace function public.pos_sync_pull(p_secret text, p_since bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cursor bigint;
begin
  perform pos.check_secret(p_secret);
  select greatest(
    coalesce(p_since, 0),
    coalesce((select max(rev) from pos.branches), 0),
    coalesce((select max(rev) from pos.transfers), 0),
    coalesce((select max(rev) from pos.categories), 0),
    coalesce((select max(rev) from pos.products), 0),
    coalesce((select max(rev) from pos.batches), 0),
    coalesce((select max(rev) from pos.movements), 0)
  ) into v_cursor;

  return jsonb_build_object(
    'cursor', v_cursor,
    'branches', coalesce((
      select jsonb_agg(b.doc order by b.rev) from pos.branches b where b.rev > p_since
    ), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(jsonb_build_object('doc', t.doc, 'items', t.items) order by t.rev)
      from pos.transfers t where t.rev > p_since
    ), '[]'::jsonb),
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

-- Sales made after revision p_since, oldest first, at most p_limit (1–1000). Each till copies the other tills' sales
-- so the reports can show any branch; it skips its own.
create or replace function public.pos_sync_pull_sales(p_secret text, p_since bigint, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sales jsonb;
begin
  perform pos.check_secret(p_secret);
  select coalesce(jsonb_agg(jsonb_build_object('doc', s.doc, 'device_id', s.device_id, 'rev', s.rev) order by s.rev), '[]')
  into v_sales
  from (
    select * from pos.sales where rev > coalesce(p_since, 0)
    order by rev limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  ) s;
  return jsonb_build_object(
    'sales', v_sales,
    'cursor', coalesce((select max((e->>'rev')::bigint) from jsonb_array_elements(v_sales) e), p_since, 0)
  );
end $$;

revoke execute on all functions in schema pos from public, anon, authenticated;
revoke execute on function public.pos_sync_push(text, jsonb, jsonb) from public;
revoke execute on function public.pos_sync_pull(text, bigint) from public;
revoke execute on function public.pos_sync_pull_sales(text, bigint, integer) from public;
grant execute on function public.pos_sync_push(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.pos_sync_pull(text, bigint) to anon, authenticated;
grant execute on function public.pos_sync_pull_sales(text, bigint, integer) to anon, authenticated;
