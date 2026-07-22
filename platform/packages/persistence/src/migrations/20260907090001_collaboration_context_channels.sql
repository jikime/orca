alter table collaboration.channels
  add constraint channels_context_unique unique (organization_id, scope_type, scope_id);
