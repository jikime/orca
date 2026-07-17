-- R6 slice 1: CRM / CONTRACT bounded context — customer 360 (accounts/sites/contacts),
-- sales pipeline (opportunities), and the contract core that carries the load-bearing
-- exit condition "계약 범위와 변경 범위를 구분하고 승인 전 실행을 제한한다" (doc 14 §R6,
-- doc 13:90-108). Same tenant model as delivery/identity: composite (organization_id, id)
-- keys + composite FKs so a child can never reference a parent in another org, and the
-- permissive tenant_isolation + restrictive tenant_boundary_guard + FORCE RLS pair keyed on
-- pie.organization_id. WBS/gantt/requirements/tickets/import are LATER R6 slices.
create schema if not exists crm;
grant usage on schema crm to pie_app;
grant usage on schema crm to pie_worker;

-- crm.accounts: the customer company (doc 13 CustomerAccount). external_ref is the
-- import-source id preserved for future Jira/Redmine/CSV re-run dedup (a later R6 slice);
-- it is nullable and unique-per-org only when present.
create table crm.accounts (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  name text not null,
  status text not null default 'prospect',
  owner_user_id uuid,
  external_ref text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint accounts_status_check
    check (status in ('prospect', 'active', 'inactive')),
  constraint accounts_external_ref_unique unique (organization_id, external_ref)
);

-- crm.account_sites (사업장) and crm.account_contacts (담당자): the "고객 360" child tables.
create table crm.account_sites (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  name text not null,
  timezone text not null default 'Asia/Seoul',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint account_sites_account_fk
    foreign key (organization_id, account_id) references crm.accounts (organization_id, id)
    on delete cascade
);

create table crm.account_contacts (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  site_id uuid,
  name text not null,
  email text,
  role text,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint account_contacts_account_fk
    foreign key (organization_id, account_id) references crm.accounts (organization_id, id)
    on delete cascade,
  constraint account_contacts_site_fk
    foreign key (organization_id, site_id) references crm.account_sites (organization_id, id)
    on delete set null
);

-- crm.opportunities: the sales pipeline (doc 13 Opportunity). stage is the pipeline
-- state; won/lost are terminal.
create table crm.opportunities (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  name text not null,
  stage text not null default 'lead',
  amount numeric(18, 2) not null default 0,
  probability integer,
  owner_user_id uuid,
  expected_close_at date,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint opportunities_account_fk
    foreign key (organization_id, account_id) references crm.accounts (organization_id, id)
    on delete cascade,
  constraint opportunities_stage_check
    check (stage in ('lead', 'qualified', 'proposal', 'won', 'lost'))
);

-- crm.contracts: belongs to an account (doc 13 Contract). approval_status is the gate that
-- restricts execution — a project may only be created against an APPROVED (or 'changed',
-- i.e. approved-then-amended) contract. approved_by/submitted_by record the approver ≠
-- submitter separation; the snapshot of who approved is audited too (doc 13:289).
create table crm.contracts (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  title text not null,
  contract_value numeric(18, 2) not null default 0,
  approval_status text not null default 'draft',
  effective_start date,
  effective_end date,
  submitted_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint contracts_account_fk
    foreign key (organization_id, account_id) references crm.accounts (organization_id, id)
    on delete cascade,
  constraint contracts_approval_status_check
    check (approval_status in ('draft', 'pending_approval', 'approved', 'rejected', 'changed'))
);

-- crm.contract_scope_items: the committed BASE SCOPE line items (doc 13 ContractLine). The
-- effective scope of a contract = these base items + the deltas of APPROVED change orders.
create table crm.contract_scope_items (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  contract_id uuid not null,
  service_type text not null,
  description text,
  quantity numeric(18, 2) not null default 1,
  rate numeric(18, 2) not null default 0,
  sort_key integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint contract_scope_items_contract_fk
    foreign key (organization_id, contract_id) references crm.contracts (organization_id, id)
    on delete cascade
);

-- crm.change_orders (변경계약): belongs to a contract and carries a DISTINCT change scope
-- (its own scope_items below), kept SEPARATE from the base scope. Its delta only becomes part
-- of the effective scope once its own approval_status = 'approved' — no execution before
-- approval, applied to the change too. customer_approver_user_id records the customer who
-- approved (doc 14 §R6 변경요청과 고객 승인).
create table crm.change_orders (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  contract_id uuid not null,
  title text not null,
  approval_status text not null default 'draft',
  value_delta numeric(18, 2) not null default 0,
  submitted_by uuid,
  customer_approver_user_id uuid,
  approved_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint change_orders_contract_fk
    foreign key (organization_id, contract_id) references crm.contracts (organization_id, id)
    on delete cascade,
  constraint change_orders_approval_status_check
    check (approval_status in ('draft', 'pending_approval', 'approved', 'rejected'))
);

-- crm.change_order_scope_items: the scope DELTA of a change order — a set of line items
-- SEPARATE from crm.contract_scope_items. change_kind distinguishes an added/removed/modified
-- line so the delta is explicit, not a full re-statement of scope.
create table crm.change_order_scope_items (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  change_order_id uuid not null,
  change_kind text not null default 'add',
  service_type text not null,
  description text,
  quantity numeric(18, 2) not null default 1,
  rate numeric(18, 2) not null default 0,
  sort_key integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint change_order_scope_items_order_fk
    foreign key (organization_id, change_order_id) references crm.change_orders (organization_id, id)
    on delete cascade,
  constraint change_order_scope_items_kind_check
    check (change_kind in ('add', 'remove', 'modify'))
);

-- crm.contract_projects: the OPAQUE cross-schema link from a contract to the delivery.projects
-- row created at the execution gate. project_id is an opaque id into delivery — deliberately
-- NO cross-schema FK (mirrors how other schemas reference by id). One project per link row;
-- a contract may spawn several projects over its life.
create table crm.contract_projects (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  contract_id uuid not null,
  project_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint contract_projects_contract_fk
    foreign key (organization_id, contract_id) references crm.contracts (organization_id, id)
    on delete cascade,
  constraint contract_projects_project_unique unique (organization_id, project_id)
);

-- === RLS: the standard tenant pair on every crm table ===
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'account_sites', 'account_contacts', 'opportunities',
    'contracts', 'contract_scope_items', 'change_orders', 'change_order_scope_items',
    'contract_projects'
  ]
  loop
    execute format('alter table crm.%I enable row level security', t);
    execute format('alter table crm.%I force row level security', t);
    execute format(
      'create policy %I on crm.%I as permissive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
    execute format(
      'create policy %I on crm.%I as restrictive for all to pie_app '
      || 'using (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid) '
      || 'with check (organization_id = nullif(current_setting(''pie.organization_id'', true), '''')::uuid)',
      t || '_tenant_boundary_guard', t);
    execute format('grant select, insert, update, delete on crm.%I to pie_app', t);
  end loop;
end
$$;
