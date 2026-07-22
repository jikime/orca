-- Structured transcript authority: canonical timed segments plus immutable correction history.
create table meetings.transcript_segments (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  transcript_id uuid not null,
  sequence integer not null,
  speaker_participant_id uuid,
  speaker_label text not null,
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  language text,
  confidence double precision,
  source text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint transcript_segments_transcript_fk
    foreign key (organization_id, transcript_id)
    references meetings.transcripts (organization_id, id) on delete cascade,
  constraint transcript_segments_sequence_unique unique (organization_id, transcript_id, sequence),
  constraint transcript_segments_sequence_check check (sequence >= 0),
  constraint transcript_segments_time_check check (start_ms >= 0 and end_ms >= start_ms),
  constraint transcript_segments_text_check check (length(btrim(text)) > 0),
  constraint transcript_segments_speaker_check check (length(btrim(speaker_label)) > 0),
  constraint transcript_segments_confidence_check check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  constraint transcript_segments_source_check check (
    source in ('live_caption', 'post_recording', 'corrected')
  )
);

create index transcript_segments_timeline_idx
  on meetings.transcript_segments (organization_id, transcript_id, sequence, id);
create index transcript_segments_search_idx
  on meetings.transcript_segments using gin (to_tsvector('simple', text));

create table meetings.transcript_segment_revisions (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  segment_id uuid not null,
  revision bigint not null,
  speaker_participant_id uuid,
  speaker_label text not null,
  text text not null,
  edited_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint transcript_segment_revisions_segment_fk
    foreign key (organization_id, segment_id)
    references meetings.transcript_segments (organization_id, id) on delete cascade,
  constraint transcript_segment_revisions_unique
    unique (organization_id, segment_id, revision)
);

create index transcript_segment_revisions_segment_idx
  on meetings.transcript_segment_revisions (organization_id, segment_id, revision);

alter table meetings.transcript_segments enable row level security;
alter table meetings.transcript_segments force row level security;
create policy transcript_segments_tenant_isolation on meetings.transcript_segments
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy transcript_segments_tenant_boundary_guard on meetings.transcript_segments
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

alter table meetings.transcript_segment_revisions enable row level security;
alter table meetings.transcript_segment_revisions force row level security;
create policy transcript_segment_revisions_tenant_isolation on meetings.transcript_segment_revisions
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy transcript_segment_revisions_tenant_boundary_guard on meetings.transcript_segment_revisions
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);

grant select, insert, update, delete on meetings.transcript_segments to pie_app;
grant select, insert, update, delete on meetings.transcript_segment_revisions to pie_app;
