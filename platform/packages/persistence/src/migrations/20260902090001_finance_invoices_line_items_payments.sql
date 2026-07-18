-- R9 slice: FINANCE — invoices + line items + payments (doc 14 §R9 "재무·연동·엔터프라이즈 완성",
-- the 계약별 청구 / billing piece). A running org bills a customer account (optionally tied to a
-- contract and/or project): an invoice carries line items whose amounts sum into the invoice subtotal
-- (total = subtotal + tax_amount, recomputed from the lines while draft), an :issue gate freezes the
-- lines and stamps the issue date, and append-only payments atomically draw down the outstanding
-- balance and walk the status issued → partially_paid → paid. Dedicated `finance` schema so every
-- reference to crm.accounts, crm.contracts, and delivery.projects is a genuine OPAQUE cross-schema id
-- — no cross-schema FK, same-tenant integrity via the shared organization_id (mirrors
-- crm.contract_projects / assets.assets / governance.*).
create schema if not exists finance;
grant usage on schema finance to pie_app;
grant usage on schema finance to pie_worker;

-- finance.invoices: a bill for a customer account. account_id / contract_id / project_id are OPAQUE
-- links (no FK). subtotal/total are RECOMPUTED from the line items (total = subtotal + tax_amount);
-- amount_paid is drawn down by payments. status walks draft → issued → partially_paid → paid, or
-- draft|issued|partially_paid → void. invoice_number is unique per org. version is the OCC counter.
create table finance.invoices (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  contract_id uuid,
  project_id uuid,
  invoice_number text not null,
  status text not null default 'draft',
  currency text not null default 'KRW',
  subtotal numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  amount_paid numeric(14, 2) not null default 0,
  issue_date date,
  due_date date,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint invoices_status_check
    check (status in ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  constraint invoices_number_unique unique (organization_id, invoice_number),
  -- money is never negative; amount_paid may never exceed the total (overpayment is refused at write).
  constraint invoices_amounts_nonneg
    check (subtotal >= 0 and tax_amount >= 0 and total >= 0 and amount_paid >= 0),
  constraint invoices_amount_paid_within_total check (amount_paid <= total)
);

create index invoices_account_idx on finance.invoices (organization_id, account_id, id);
create index invoices_contract_idx on finance.invoices (organization_id, contract_id, id);
create index invoices_project_idx on finance.invoices (organization_id, project_id, id);
create index invoices_status_idx on finance.invoices (organization_id, status, id);

-- finance.invoice_line_items: the billed lines. invoice_id is an OPAQUE id (no cross-schema FK, but a
-- same-schema composite FK to the parent so a line can never dangle or cross tenants). amount is
-- computed on write as round(quantity * unit_price, 2); adding/removing a line recomputes the parent
-- invoice subtotal/total (only while draft). sort_order is the display order.
create table finance.invoice_line_items (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  description text not null,
  quantity numeric(14, 2) not null default 1,
  unit_price numeric(14, 2) not null default 0,
  amount numeric(14, 2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint invoice_line_items_invoice_fk
    foreign key (organization_id, invoice_id) references finance.invoices (organization_id, id)
    on delete cascade,
  constraint invoice_line_items_amounts_nonneg
    check (quantity >= 0 and unit_price >= 0 and amount >= 0)
);

create index invoice_line_items_invoice_idx
  on finance.invoice_line_items (organization_id, invoice_id, sort_order, id);

-- finance.payments: append-only receipts. invoice_id is a same-schema composite FK (never crosses
-- tenants). Recording a payment atomically increments the parent invoice amount_paid under a row lock
-- and moves its status; an amount exceeding the outstanding balance is refused before any write, so a
-- payment row exists only for money actually applied. recorded_by is the OPAQUE actor id.
create table finance.payments (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  amount numeric(14, 2) not null,
  paid_at timestamptz not null default now(),
  method text not null default 'bank_transfer',
  reference text,
  recorded_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint payments_invoice_fk
    foreign key (organization_id, invoice_id) references finance.invoices (organization_id, id)
    on delete cascade,
  constraint payments_method_check
    check (method in ('bank_transfer', 'card', 'cash', 'other')),
  constraint payments_amount_positive check (amount > 0)
);

create index payments_invoice_idx on finance.payments (organization_id, invoice_id, paid_at, id);

-- === RLS: the standard tenant pair (permissive isolation + restrictive boundary guard + FORCE) ===
do $$
declare
  t text;
begin
  foreach t in array array['invoices', 'invoice_line_items', 'payments']
  loop
    execute format('alter table finance.%I enable row level security', t);
    execute format('alter table finance.%I force row level security', t);
    execute format(
      'create policy %I on finance.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on finance.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on finance.%I to pie_app', t);
  end loop;
end
$$;
