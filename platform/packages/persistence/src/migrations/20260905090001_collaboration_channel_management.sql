-- Channel lifecycle metadata for Slack-core administration. Archived channels
-- remain readable and recoverable; they are never hard-deleted by this workflow.
alter table collaboration.channels
  add column topic text not null default '',
  add column description text not null default '',
  add column archived_at timestamptz;

alter table collaboration.channels
  add constraint channels_topic_length_check check (char_length(topic) <= 250),
  add constraint channels_description_length_check check (char_length(description) <= 2000);
