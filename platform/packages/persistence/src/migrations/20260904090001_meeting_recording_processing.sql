-- Egress is asynchronous: keep both output jobs on the durable recording row so stop requests and
-- retried LiveKit webhooks can resolve the same recording after an API restart.
alter table meetings.recordings
  add column video_egress_id text,
  add column audio_egress_id text,
  add column transcription_dispatch_id text,
  add column stopped_at timestamptz,
  add column error_code text;

create unique index recordings_one_pending_per_meeting_idx
  on meetings.recordings (organization_id, meeting_id)
  where status = 'pending';

alter table meetings.media_events drop constraint meeting_media_events_type_check;
alter table meetings.media_events
  add constraint meeting_media_events_type_check
    check (event_type in ('participant_joined', 'participant_left', 'egress_ended', 'live_caption'));

-- A durable, leased queue separates media webhooks from expensive model calls. The unique key makes
-- every processing stage idempotent even when LiveKit retries its completion webhook.
create table meetings.processing_jobs (
  organization_id uuid not null references identity.organizations (id),
  id uuid not null default gen_random_uuid(),
  meeting_id uuid not null,
  recording_id uuid not null,
  job_type text not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  leased_until timestamptz,
  worker_id text,
  last_error text,
  transcript_id uuid,
  minutes_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, recording_id, job_type),
  constraint meeting_processing_jobs_type_check check (job_type in ('transcribe', 'summarize')),
  constraint meeting_processing_jobs_status_check
    check (status in ('queued', 'processing', 'completed', 'failed')),
  constraint meeting_processing_jobs_attempts_check check (attempts >= 0)
);

create index meeting_processing_jobs_claim_idx
  on meetings.processing_jobs (status, available_at, leased_until, id);
create index meeting_processing_jobs_meeting_idx
  on meetings.processing_jobs (organization_id, meeting_id, created_at, id);

alter table meetings.processing_jobs enable row level security;
alter table meetings.processing_jobs force row level security;
create policy meeting_processing_jobs_tenant_isolation on meetings.processing_jobs
  as permissive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
create policy meeting_processing_jobs_tenant_boundary_guard on meetings.processing_jobs
  as restrictive for all to pie_app
  using (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('pie.organization_id', true), '')::uuid);
grant select, insert, update on meetings.processing_jobs to pie_app;

-- Queue consumers need a cross-tenant claim view but remain NOBYPASSRLS and cannot delete jobs.
create policy meeting_processing_jobs_worker_access on meetings.processing_jobs
  as permissive for select to pie_worker using (true);
create policy meeting_processing_jobs_worker_update on meetings.processing_jobs
  as permissive for update to pie_worker using (true) with check (true);
grant select, update on meetings.processing_jobs to pie_worker;
