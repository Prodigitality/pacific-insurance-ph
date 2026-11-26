"use server";

import { revalidatePath } from "next/cache";
import { getActor, type ActionResult } from "@/lib/actions/context";
import { assertRecordAccess, RecordAccessError } from "@/lib/auth/agent-scope";
import { attachRequirementDocument, beginRequirementAttachmentUpload, listAttachedRequirementDocuments, listRequirementEmailAttachments, removeRequirementAttachment, requirementAttachmentError } from "@/lib/documents/requirement-attachments";
import type { AttachmentPickerScope, RequirementAttachmentPage, RequirementAttachmentReceipt, RequirementAttachmentRemoval, RequirementReceiptSource, RequirementTarget } from "@/lib/documents/requirement-attachment.types";

/** Agent scope (Phase J9) surfaces as "Record not found."; other failures keep their safe mapping. */
function actionError(error: unknown): string {
  return error instanceof RecordAccessError ? error.message : requirementAttachmentError(error);
}

export async function listRequirementEmailAttachmentsAction(scope: AttachmentPickerScope, options?: { search?: string; offset?: number }): Promise<ActionResult<RequirementAttachmentPage>> {
  try {
    if (scope.type === "client") await assertRecordAccess("client", scope.clientId);
    else await assertRecordAccess(scope.target.kind, scope.target.recordId);
    return { ok: true, data: await listRequirementEmailAttachments(scope, options) };
  }
  catch (error) { return { ok: false, error: actionError(error) }; }
}

export async function beginRequirementAttachmentUploadAction(target: RequirementTarget, input: { fileName: string; mimeType: string; size: number }): Promise<ActionResult<{ path: string; token: string }>> {
  try {
    await assertRecordAccess(target.kind, target.recordId);
    return { ok: true, data: await beginRequirementAttachmentUpload(target, input) };
  }
  catch (error) { return { ok: false, error: actionError(error) }; }
}

export async function attachRequirementDocumentAction(target: RequirementTarget, source: RequirementReceiptSource): Promise<ActionResult<RequirementAttachmentReceipt>> {
  try {
    await assertRecordAccess(target.kind, target.recordId);
    const receipt = await attachRequirementDocument(target, source);
    revalidatePath("/documents");
    revalidatePath(target.kind === "application" ? "/applications" : target.kind === "claim" ? "/claims" : "/travel");
    if (receipt.document.clientId) revalidatePath(`/clients/${receipt.document.clientId}`);
    return { ok: true, data: receipt };
  } catch (error) { return { ok: false, error: actionError(error) }; }
}

export async function listAttachedRequirementDocumentsAction(target: RequirementTarget): Promise<ActionResult<{ documents: { id: string; name: string }[]; canRemove: boolean }>> {
  try {
    await assertRecordAccess(target.kind, target.recordId);
    return { ok: true, data: await listAttachedRequirementDocuments(target) };
  } catch (error) { return { ok: false, error: actionError(error) }; }
}

export async function removeRequirementAttachmentAction(target: RequirementTarget, documentId: string): Promise<ActionResult<RequirementAttachmentRemoval>> {
  try {
    const actor = await getActor();
    if (actor.role !== "Owner" && actor.role !== "Admin") return { ok: false, error: "Only an Admin can remove a checklist attachment." };
    await assertRecordAccess(target.kind, target.recordId);
    await assertRecordAccess("document", documentId);
    const { clientId, removal } = await removeRequirementAttachment(target, documentId, actor.id);
    for (const path of ["/documents", target.kind === "application" ? "/applications" : target.kind === "claim" ? "/claims" : "/travel", `/clients/${clientId}`]) {
      try { revalidatePath(path); }
      catch { console.error("Requirement attachment cache invalidation failed", { documentId, path }); }
    }
    return { ok: true, data: removal };
  } catch (error) { return { ok: false, error: actionError(error) }; }
}
