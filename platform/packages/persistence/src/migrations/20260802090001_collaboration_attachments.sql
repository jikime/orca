-- Chat slice 6: message attachments — REUSING the R2 object-storage/artifact pipeline
-- (the object-storage-adapter tenant key-builder + presign + HEAD), NOT a second
-- uploader. Design-reference-only. Attachments ride the message.created realtime.
--
-- One table with a NULLABLE message_id: a row starts as a 'pending' upload intent
-- (message_id NULL, keyed to its channel for member-gating), then flips to 'linked'
-- with its message_id when a post finalizes it (HEAD-verified). channel_id gates the
-- intent/download; the composite same-tenant FKs keep it in-tenant, in-channel.
create table collaboration.message_attachments (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  channel_id uuid not null,
  message_id uuid,
  object_id uuid not null,
  storage_key text not null,
  filename text not null,
  content_type text not null,
  byte_size bigint not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint message_attachments_status_check check (status in ('pending', 'linked')),
  constraint message_attachments_filename_len check (char_length(filename) between 1 and 255),
  constraint message_attachments_byte_size_check check (byte_size >= 0),
  constraint message_attachments_channel_fk
    foreign key (organization_id, channel_id) references collaboration.channels (organization_id, id)
    on delete cascade,
  constraint message_attachments_message_fk
    foreign key (organization_id, message_id) references collaboration.messages (organization_id, id)
    on delete cascade
);

create index message_attachments_message_idx
  on collaboration.message_attachments (organization_id, message_id)
  where message_id is not null;

-- === RLS: the standard tenant pair ===
alter table collaboration.message_attachments enable row level security;
alter table collaboration.message_attachments force row level security;
create policy message_attachments_tenant_isolation on collaboration.message_attachments
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy message_attachments_tenant_boundary_guard on collaboration.message_attachments
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update, delete on collaboration.message_attachments to pie_app;
