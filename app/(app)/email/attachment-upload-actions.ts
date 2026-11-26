"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/context";
import { recordActivity } from "@/lib/activity/log";
import { assertRecordAccess } from "@/lib/auth/agent-scope";
import { outboundEmailErrorMessage, requireEmailSender } from "@/lib/communications/outbound-email";
import type { EmailDocumentOption } from "@/lib/communications/outbound-email.types";
import { registerUploadedPdf } from "@/lib/documents/uploaded-pdf";

const RENEWAL_NOTICE_DOCUMENT_TYPE = "Renewal Notice";
const GENERIC_DOCUMENT_TYPE = "Other";

/**
 * File a PDF the browser already wrote to Storage (`beginPdfUploadAction` + signed upload) as a
 * document of this client, so the email composer can attach it. A thin wrapper over the same
 * `registerUploadedPdf` the policy and Travel uploads use: the path and size are re-verified there.
 * Only the real email sender (not a persona preview) may use it, matching the composer itself.
 */
export async function registerEmailAttachmentUploadAction(
  clientId: string,
  path: string,
  fileName: string,
  renewalNotice: boolean,
): Promise<ActionResult<EmailDocumentOption>> {
  try {
    const actor = await requireEmailSender().catch((error: unknown) => {
      throw new Error(outboundEmailErrorMessage(error));
    });
    await assertRecordAccess("client", clientId);
    const documentType = renewalNotice ? RENEWAL_NOTICE_DOCUMENT_TYPE : GENERIC_DOCUMENT_TYPE;
    const doc = await registerUploadedPdf({ path, name: fileName, clientId, documentType, actorId: actor.id });
    await recordActivity({
      scopeType: "client",
      scopeId: clientId,
      activityType: "document.uploaded",
      summary: `Document “${doc.name}” uploaded for an email`,
      actorId: actor.id,
    });
    revalidatePath(`/clients/${clientId}`);
    revalidatePath("/documents");
    return { ok: true, data: { id: doc.id, name: doc.name, documentType: doc.documentType, uploadedAt: doc.uploadedAt, recordLabel: doc.documentType } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Couldn’t attach the file." };
  }
}
