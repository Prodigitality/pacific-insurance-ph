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
-- * Replacing the PDF (replace_proposal_pdf below) takes the same client lock first, so removal
--   and replacement serialize: if removal won, the lead is Requested with no active PDF and the
--   replacement creates nothing; if replacement won, the removal's target is Replaced and fails.
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

-- Swap in a corrected proposal PDF for a lead whose proposal was already received. The new
-- document is filed and every prior active proposal of the client is retired as Replaced in one
-- transaction under the client lock. Proposal status and decision are kept as they are; Replaced
-- history is never deleted or promoted. Access mirrors register_proposal_receipt: Owner, Admin and
-- Assistant, or a Viewer (Agent) on a lead assigned to them.
create function public.replace_proposal_pdf(p_actor_id uuid, p_client_id uuid, p_storage_path text, p_name text)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  actor_role text;
  lead public.clients%rowtype;
  existing public.documents%rowtype;
  doc uuid;
  old_doc record;
  replaced uuid[] := '{}';
begin
  select role into actor_role from public.users
    where id = p_actor_id and status = 'Active' and role in ('Owner','Admin','Assistant','Viewer');
  if not found then
    raise exception 'proposal_replace_forbidden' using errcode = '42501';
  end if;

  select * into lead from public.clients where id = p_client_id for update;
  if not found then raise exception 'proposal_replace_stale' using errcode = '22023'; end if;
  if actor_role = 'Viewer' and lead.assigned_user_id is distinct from p_actor_id then
    raise exception 'proposal_replace_forbidden' using errcode = '42501';
  end if;

  if p_storage_path is null or left(p_storage_path, length(p_client_id::text) + 1) <> p_client_id::text || '/'
    or p_storage_path !~ '\.(pdf|png|jpg)$' or p_name is null or length(p_name) not between 1 and 1024 then
    raise exception 'proposal_replace_invalid' using errcode = '22023';
  end if;

  -- A repeated call for an upload that is already the current proposal changes nothing.
  select * into existing from public.documents where file_path = p_storage_path order by created_at, id limit 1;
  if found then
    if existing.client_id = p_client_id and existing.document_type = 'Illustrative Proposal'
      and existing.status <> 'Replaced' and existing.application_id is null then
      return existing.id;
    end if;
    raise exception 'proposal_replace_invalid' using errcode = '22023';
  end if;

  -- Fresh state under the lock: a removal that won leaves Requested and no active PDF.
  if lead.lifecycle_stage is distinct from 'Lead' or lead.proposal_status is null or lead.proposal_status = 'Requested'
    or not exists(select 1 from public.documents d where d.client_id = p_client_id
      and d.document_type = 'Illustrative Proposal' and d.status <> 'Replaced') then
    raise exception 'proposal_replace_stale' using errcode = '22023';
  end if;

  insert into public.documents(client_id, document_type, name, file_path, uploaded_by, visibility, status)
    values (p_client_id, 'Illustrative Proposal', p_name, p_storage_path, p_actor_id, 'Internal Only', 'Uploaded')
    returning id into doc;

  for old_doc in select d.id, d.status from public.documents d where d.client_id = p_client_id
      and d.document_type = 'Illustrative Proposal' and d.status <> 'Replaced' and d.id <> doc
      order by d.id for update loop
    update public.documents set status = 'Replaced' where id = old_doc.id;
    replaced := replaced || old_doc.id;
    insert into public.audit_logs(actor_id, action, table_name, record_id, previous_value, new_value)
      values (p_actor_id, 'update', 'documents', old_doc.id, jsonb_build_object('status', old_doc.status),
        jsonb_build_object('status', 'Replaced', 'replacedBy', doc));
  end loop;

  insert into public.audit_logs(actor_id, action, table_name, record_id, new_value)
    values (p_actor_id, 'proposal.replaced', 'documents', doc,
      jsonb_build_object('client_id', p_client_id, 'name', p_name, 'path', p_storage_path,
        'document_type', 'Illustrative Proposal', 'replaced_document_ids', to_jsonb(replaced),
        'proposal_status', lead.proposal_status, 'proposal_decision', lead.proposal_decision));
  insert into public.activity_timeline(scope_type, scope_id, activity_type, summary, actor_id, metadata)
    values ('client', p_client_id, 'lead.proposal',
      concat('Proposal PDF replaced — ', coalesce(lead.product_interest, 'carrier'), ' illustrative proposal re-uploaded'),
      p_actor_id, jsonb_build_object('document_id', doc, 'replaced_document_ids', to_jsonb(replaced)));
  return doc;
end;
$$;
revoke all on function public.replace_proposal_pdf(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.replace_proposal_pdf(uuid, uuid, text, text) to service_role;
