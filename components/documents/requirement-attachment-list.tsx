"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { listAttachedRequirementDocumentsAction, removeRequirementAttachmentAction } from "@/app/(app)/documents/requirement-attachment-actions";
import { I } from "@/components/hub/icons";
import { Btn } from "@/components/hub/primitives";
import { useOverlays } from "@/components/hub/overlays/overlay-provider";
import { usePersona } from "@/components/hub/persona";
import type { RequirementAttachmentRemoval, RequirementTarget } from "@/lib/documents/requirement-attachment.types";

type AttachmentListing = { documents: { id: string; name: string }[]; canRemove: boolean };

/** No list request until this checklist row's disclosure is opened. */
export function RequirementAttachmentList({ target, label, revision, disabled, onRemoved, onBusyChange }: {
  target: RequirementTarget;
  label: string;
  revision: number;
  disabled?: boolean;
  onRemoved: (result: RequirementAttachmentRemoval) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const overlays = useOverlays();
  const persona = usePersona();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ targetKey: string; key: string; data: AttachmentListing | null; error: string | null } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const requestSeq = useRef(0);
  const { kind, recordId, requirementId } = target;
  const targetKey = `${kind}:${recordId}:${requirementId}`;
  const loadKey = `${targetKey}:${revision}:${retry}`;
  const data = loaded?.targetKey === targetKey ? loaded.data : null;
  const loading = expanded && loaded?.key !== loadKey;
  const listError = loaded?.key === loadKey ? loaded.error : null;

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    const request = ++requestSeq.current;
    void listAttachedRequirementDocumentsAction({ kind, recordId, requirementId }).then((result) => {
      if (!active || request !== requestSeq.current) return;
      setLoaded({ targetKey, key: loadKey, data: result.ok ? result.data : null, error: result.ok ? null : result.error });
    }).catch(() => {
      if (active && request === requestSeq.current) setLoaded({ targetKey, key: loadKey, data: null, error: "Attachments could not be loaded. Retry to refresh this checklist." });
    });
    return () => { active = false; };
  }, [expanded, kind, recordId, requirementId, targetKey, loadKey]);

  const remove = async (documentId: string) => {
    if (busyRef.current || disabled || loading || !data?.canRemove || persona.role !== "admin") return;
    busyRef.current = true;
    setRemovingId(documentId);
    onBusyChange(true);
    setRemovalError(null);
    try {
      const confirmed = await overlays.confirm({
        kind: "danger",
        title: "Remove attachment?",
        message: "This file will be removed from this checklist. A Received or Verified item returns to Pending. An Inbox original and its email will be retained.",
        confirmLabel: "Remove attachment",
      });
      if (!confirmed) return;
      const result = await removeRequirementAttachmentAction({ kind, recordId, requirementId }, documentId);
      if (!result.ok) { setRemovalError(result.error); return; }
      // Invalidate any older listing response before publishing the committed detach.
      requestSeq.current++;
      setLoaded((current) => current?.targetKey === targetKey && current.data ? {
        ...current, data: { ...current.data, documents: current.data.documents.filter((document) => document.id !== documentId) },
      } : current);
      const outcome = result.data.cleanupFailed
        ? "Removed from this checklist, but storage cleanup failed. The file may still exist in storage."
        : result.data.originalPreserved ? "Removed from this checklist. The Inbox original and its email were retained."
          : "Removed from this checklist.";
      setNotice(outcome);
      onRemoved(result.data);
      overlays.toast(result.data.cleanupFailed ? "Attachment removed; cleanup warning" : "Attachment removed", outcome);
      router.refresh();
    } catch {
      setRemovalError("The removal could not be confirmed. Refresh the attachments before retrying.");
    } finally {
      busyRef.current = false;
      setRemovingId(null);
      onBusyChange(false);
    }
  };

  return <div className="min-w-0">
    <button type="button" aria-expanded={expanded} aria-controls={panelId} aria-label={`Attachments for ${label}`} disabled={!!removingId} onClick={() => setExpanded((current) => !current)} className="inline-flex h-[30px] items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/25 disabled:cursor-wait disabled:opacity-60">
      <I.chevDown size={13} className={expanded ? "rotate-180" : ""} /> Attachments
    </button>
    {expanded && <div id={panelId} aria-busy={loading || !!removingId} className="mt-1 space-y-2 text-[12px]">
      {loading && <p role="status" className="text-muted-foreground">Loading attachments…</p>}
      {listError && <div role="alert" className="text-red">{listError} <Btn type="button" size="sm" disabled={!!removingId} onClick={() => setRetry((current) => current + 1)}>Retry</Btn></div>}
      {!loading && !listError && data?.documents.length === 0 && <p className="text-muted-foreground">No attachments on this checklist item.</p>}
      {data && <ul className="space-y-1">{data.documents.map((document) => <li key={document.id} className="flex min-w-0 items-center justify-between gap-2">
        <a href={`/api/documents/${document.id}/download`} target="_blank" rel="noopener noreferrer" className="min-w-0 break-words font-semibold text-brand-hover underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/25">{document.name}</a>
        {data.canRemove && persona.role === "admin" && <Btn type="button" size="sm" disabled={!!removingId || loading || disabled} onClick={() => void remove(document.id)}>{removingId === document.id ? "Removing…" : "Remove"}</Btn>}
      </li>)}</ul>}
      {removalError && <div role="alert" className="text-red">{removalError} <Btn type="button" size="sm" disabled={!!removingId} onClick={() => { setRemovalError(null); setRetry((current) => current + 1); }}>Refresh attachments</Btn></div>}
      {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
    </div>}
  </div>;
}
