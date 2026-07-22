alter table collaboration.channels
  add column retention_days integer,
  add constraint channels_retention_days_check
    check (retention_days is null or retention_days between 1 and 3650);

comment on column collaboration.channels.retention_days is
  'Null keeps messages indefinitely; otherwise retention redacts messages older than this many days.';
