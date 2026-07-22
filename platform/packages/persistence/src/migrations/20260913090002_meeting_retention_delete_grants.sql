-- Retention deletion runs inside the tenant-scoped application role so RLS remains enforced.
-- These derived tables previously allowed writes but omitted the DELETE privilege needed by that job.
grant delete on meetings.processing_jobs to pie_app;
grant delete on meetings.media_events to pie_app;
grant delete on meetings.minute_revisions to pie_app;
