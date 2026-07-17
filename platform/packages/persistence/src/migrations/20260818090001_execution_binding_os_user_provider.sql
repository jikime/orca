-- R5 audit IDN-008 + BND-002: widen the SIGNED SessionBinding identity with the OS user and the
-- provider so a shared SSH/build host with two OS users at the same path (IDN-008), and two launches
-- with the same provider-session-string under different providers (BND-002), are DISTINCT bindings
-- instead of colliding. Additive to 20260815090001: existing bound rows keep null binding_os_user /
-- binding_provider (unknown), which simply cannot match a new osUser/provider-bearing context, so no
-- backfill is required and old bindings stay valid.
--
-- Binding IDENTITY (the tuple host-discrimination compares for BINDING_HOST_MISMATCH) is now:
--   (binding_installation_id, binding_host_type, binding_host_id, binding_os_user,
--    binding_workspace_path, binding_provider)
-- This is a per-session LOGIC invariant enforced in applySessionBindingTx (a re-bind of ONE session
-- to a different tuple conflicts), NOT a cross-session unique constraint — two DIFFERENT sessions on
-- the same host/user/path/provider legitimately share a binding identity.
alter table execution.agent_sessions
  add column binding_os_user text,
  add column binding_provider text;
