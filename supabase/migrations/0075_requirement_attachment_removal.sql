-- L10 / DL8: detach exactly one checklist attachment and reset its receipt atomically.
-- Keep 0066's immutable originals, restrictive FKs and medical-review triggers intact.
create function public.detach_requirement_attachment(p_actor_id uuid, p_target jsonb, p_document_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_kind text;
  target_id uuid;
  requirement_id uuid;
  owning_client uuid;
  previous_status text;
  next_status text;
  selected_document public.documents%rowtype;
  detached jsonb;
begin
  if not exists(select 1 from public.users u where u.id = p_actor_id and u.status = 'Active' and u.role in ('Owner','Admin')) then
    raise exception 'attachment_forbidden' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_target) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_target->'kind') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_target->'recordId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_target->'requirementId') is distinct from 'string'
    or p_document_id is null then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  target_kind := p_target->>'kind';
  if target_kind not in ('application','claim','travel') then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  begin
    target_id := (p_target->>'recordId')::uuid;
    requirement_id := (p_target->>'requirementId')::uuid;
  exception when invalid_text_representation then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end;

  -- Resolve without taking a target/document lock ahead of the owning client.
  case target_kind
    when 'application' then select a.client_id into owning_client from public.applications a where a.id = target_id;
    when 'claim' then select c.client_id into owning_client from public.claims c where c.id = target_id;
    when 'travel' then select t.client_id into owning_client from public.travel_requests t where t.id = target_id;
  end case;
  if owning_client is null then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  -- Same client -> concrete target -> requirement order as receive_requirement_attachment.
  perform 1 from public.clients c where c.id = owning_client for update;
  if not found then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  if not public.lock_gmail_inbox_target(target_kind, target_id, owning_client) then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  case target_kind
    when 'application' then
      select r.status into previous_status from public.application_requirements r where r.id = requirement_id and r.application_id = target_id for update;
    when 'claim' then
      select r.status into previous_status from public.claim_requirements r where r.id = requirement_id and r.claim_id = target_id for update;
    when 'travel' then
      select r.status into previous_status from public.travel_request_requirements r where r.id = requirement_id and r.travel_request_id = target_id for update;
  end case;
  if previous_status is null then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  select * into selected_document from public.documents d where d.id = p_document_id for update;
  if selected_document.id is null or selected_document.client_id is distinct from owning_client
    or pg_catalog.num_nonnulls(selected_document.application_requirement_id, selected_document.claim_requirement_id, selected_document.travel_requirement_id) <> 1
    or (case target_kind
      when 'application' then selected_document.application_id = target_id and selected_document.application_requirement_id = requirement_id
      when 'claim' then selected_document.claim_id = target_id and selected_document.claim_requirement_id = requirement_id
      when 'travel' then selected_document.travel_request_id = target_id and selected_document.travel_requirement_id = requirement_id
    end) is not true then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;
  -- Historical device uploads can predate usage rows. If a usage exists it must
  -- agree with the document's exact checklist association before generic removal.
  if exists(select 1 from public.requirement_attachment_usages u where u.document_id = p_document_id
    and (case target_kind
      when 'application' then u.application_requirement_id = requirement_id
      when 'claim' then u.claim_requirement_id = requirement_id
      when 'travel' then u.travel_requirement_id = requirement_id
    end) is not true) then
    raise exception 'This attachment changed. Refresh and try again.' using errcode = '22023';
  end if;

  -- The existing helper preserves Inbox source identities/filings/bytes and
  -- returns only unshared direct-upload paths. Any FK/immutable failure rolls
  -- this entire call back, including receipt and medical-review changes.
  detached := public.delete_document_safely(p_actor_id, p_document_id);
  next_status := case when previous_status in ('Received','Verified') then 'Pending' else previous_status end;
  if next_status is distinct from previous_status then
    case target_kind
      when 'application' then update public.application_requirements set status = next_status where id = requirement_id;
      when 'claim' then update public.claim_requirements set status = next_status where id = requirement_id;
      when 'travel' then update public.travel_request_requirements set status = next_status where id = requirement_id;
    end case;
  end if;
  insert into public.audit_logs(actor_id, action, table_name, record_id, previous_value, new_value)
  values(p_actor_id, 'requirement.attachment_removed', 'documents', p_document_id,
    pg_catalog.jsonb_build_object('target_kind', target_kind, 'target_id', target_id, 'requirement_id', requirement_id,
      'document_id', p_document_id, 'requirement_status', previous_status),
    pg_catalog.jsonb_build_object('target_kind', target_kind, 'target_id', target_id, 'requirement_id', requirement_id,
      'document_id', p_document_id, 'requirement_status', next_status, 'original_preserved', (detached->>'originalPreserved')::boolean));
  return pg_catalog.jsonb_build_object('storagePath', detached->'storagePath', 'requirementStatus', next_status,
    'originalPreserved', (detached->>'originalPreserved')::boolean);
end;
$$;
revoke all on function public.detach_requirement_attachment(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.detach_requirement_attachment(uuid, jsonb, uuid) to service_role;
