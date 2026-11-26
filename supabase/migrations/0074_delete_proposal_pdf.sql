-- L11 / DL9: an Admin removes the lead's current illustrative proposal PDF and proposal tracking
-- returns to Requested, in one locked transaction.
--
-- * A direct upload loses its documents row. Its Storage path is returned for the caller to
--   remove only when no other document, Inbox filing, requirement source or pending upload still
--   references those bytes. Storage cannot share this transaction, so the caller removes the
--   object after commit and reports a failed cleanup instead of hiding it.
-- * A PDF filed from the Inbox (or an immutable requirement original) is only retired to
--   `Replaced`, the existing retirement state. The document, its client and associations, the
--   email filing, the source identity and the file bytes all stay; it remains historical evidence
--   in Documents. The RESTRICT FKs (0052, 0057) and immutable-original triggers are untouched.
-- * The client is locked first, then the document, matching register_proposal_receipt and Inbox
--   filing, so a concurrent receipt serializes behind this removal. Any stale target fails with
--   no side effects; any FK violation on delete aborts the whole transaction, including the
--   status reset. Lead stage, status and lifecycle are never rewound. Replaced historical PDFs
--   stay Replaced and are never promoted.
-- * delete_document_safely (0066) keeps its generic contract and is not used here.
create function public.delete_proposal_pdf(p_actor_id uuid, p_client_id uuid, p_document_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  lead public.clients%rowtype;
  d public.documents%rowtype;
  preserved boolean := false;
  path text;
begin
  if not exists(select 1 from public.users u where u.id = p_actor_id and u.status = 'Active' and u.role in ('Owner','Admin')) then
    raise exception 'proposal_delete_forbidden' using errcode = '42501';
  end if;

  select * into lead from public.clients where id = p_client_id for update;
  if not found or lead.lifecycle_stage is distinct from 'Lead'
    or lead.proposal_status is null or lead.proposal_status = 'Requested' then
    raise exception 'proposal_delete_stale' using errcode = '22023';
  end if;

  select * into d from public.documents where id = p_document_id for update;
  if not found or d.client_id is distinct from p_client_id
    or d.document_type is distinct from 'Illustrative Proposal' or d.status = 'Replaced'
    or num_nonnulls(d.application_id, d.claim_id, d.travel_request_id, d.policy_id, d.renewal_id, d.commission_id,
      d.application_requirement_id, d.claim_requirement_id, d.travel_requirement_id) > 0
    or exists(select 1 from public.requirement_attachment_usages u where u.document_id = d.id)
    or exists(select 1 from public.payments p where p.proof_document_id = d.id)
    or exists(select 1 from public.external_coverage c where c.proof_document_id = d.id) then
    raise exception 'proposal_delete_stale' using errcode = '22023';
  end if;

  -- Resetting to Requested under another active proposal would orphan it from tracking.
  if exists(select 1 from public.documents o where o.client_id = p_client_id and o.id <> d.id
      and o.document_type = 'Illustrative Proposal' and o.status <> 'Replaced') then
    raise exception 'proposal_delete_not_current' using errcode = '22023';
  end if;

  if exists(select 1 from public.gmail_inbox_filings f where f.document_id = d.id or f.storage_path = d.file_path)
    or exists(select 1 from public.requirement_attachment_sources s where s.original_document_id = d.id or s.storage_path = d.file_path) then
    update public.documents set status = 'Replaced' where id = d.id;
    preserved := true;
  else
    delete from public.documents where id = d.id;
    if nullif(btrim(d.file_path), '') is not null
      and not exists(select 1 from public.documents o where o.file_path = d.file_path)
      and not exists(select 1 from public.gmail_inbox_filings f where f.storage_path = d.file_path)
      and not exists(select 1 from public.requirement_attachment_sources s where s.storage_path = d.file_path)
      and not exists(select 1 from public.requirement_attachment_uploads u where u.storage_path = d.file_path) then
      path := d.file_path;
    end if;
  end if;

  update public.clients set proposal_status = 'Requested', proposal_decision = null where id = p_client_id;

  insert into public.audit_logs(actor_id, action, table_name, record_id, previous_value, new_value)
  values
    (p_actor_id, 'proposal.deleted', 'documents', d.id,
      jsonb_build_object('client_id', d.client_id, 'name', d.name, 'status', d.status, 'file_path', d.file_path,
        'uploaded_by', d.uploaded_by, 'uploaded_at', d.uploaded_at, 'notes', d.notes),
      jsonb_build_object('outcome', case when preserved then 'retired_as_replaced' else 'deleted' end,
        'original_preserved', preserved, 'status', case when preserved then 'Replaced' end,
        'storage_cleanup_path', path)),
    (p_actor_id, 'proposal.reset', 'clients', p_client_id,
      jsonb_build_object('proposal_status', lead.proposal_status, 'proposal_decision', lead.proposal_decision),
      jsonb_build_object('proposal_status', 'Requested', 'proposal_decision', null, 'document_id', d.id,
        'original_preserved', preserved));

  return jsonb_build_object('storagePath', path, 'originalPreserved', preserved);
end;
$$;
revoke all on function public.delete_proposal_pdf(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_proposal_pdf(uuid, uuid, uuid) to service_role;
