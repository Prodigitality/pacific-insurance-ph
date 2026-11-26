import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "@/lib/repositories/documents";
import type { RequirementTarget } from "./requirement-attachment.types";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(), scope: vi.fn(), detach: vi.fn(), find: vi.fn(), list: vi.fn(), removeObject: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/gmail/review", () => ({
  InboxReviewError: class extends Error { constructor(message: string, public status = 400) { super(message); } },
  requireInboxActor: mocks.actor,
  validateInboxId: (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid ID"); },
  getScopedInboxMessage: vi.fn(),
}));
vi.mock("@/lib/gmail/api", () => ({ getGmailAttachment: vi.fn() }));
vi.mock("@/lib/repositories/clients", () => ({ getClientsRepository: vi.fn() }));
vi.mock("@/lib/repositories/documents", () => ({ getDocumentsRepository: () => ({ findById: mocks.find, listByClient: mocks.list }) }));
vi.mock("@/lib/repositories/requirement-attachments", () => ({ getRequirementAttachmentsRepository: () => ({ resolveScope: mocks.scope, detach: mocks.detach }) }));
vi.mock("@/lib/supabase/storage", () => ({ removeObject: mocks.removeObject, createSignedUpload: vi.fn(), downloadObject: vi.fn(), getObjectInfo: vi.fn(), uploadObject: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => { throw new Error("Use repositories, not a live database."); } }));
vi.mock("./uploaded-pdf", () => ({ PDF_UPLOAD_MAX_BYTES: 25 * 1024 * 1024 }));

import { listAttachedRequirementDocuments, removeRequirementAttachment } from "./requirement-attachments";
import { RepositoryError } from "@/lib/repositories/types";

const clientId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const requirementId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const target: RequirementTarget = { kind: "application", recordId, requirementId };
const path = `${clientId}/requirements/private-upload.pdf`;
const admin = { id: "admin-actor", role: "Admin", appRole: "admin", status: "Active" };

function document(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: documentId, name: "Synthetic checklist.pdf", clientId, applicationId: recordId,
    applicationRequirementId: requirementId, claimId: null, claimRequirementId: null,
    travelRequestId: null, travelRequirementId: null, policyId: null, renewalId: null,
    commissionId: null, sourceLibraryDocumentId: null, referenceNo: null, documentType: "Application Requirement",
    filePath: path, status: "Uploaded", visibility: "Internal Only", version: 1,
    uploadedBy: admin.id, uploadedAt: "2026-11-26T00:00:00Z", createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z", notes: null, ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(admin);
  mocks.scope.mockResolvedValue({ clientId, status: "Verified", label: "Checklist" });
  mocks.find.mockResolvedValue(document());
  mocks.list.mockResolvedValue([document()]);
  mocks.detach.mockResolvedValue({ storagePath: path, requirementStatus: "Pending", originalPreserved: false });
  mocks.removeObject.mockResolvedValue(undefined);
});

describe("scoped attachment listing", () => {
  it.each(["application", "claim", "travel"] as const)("exposes only exact %s requirement attachments, without private metadata", async (kind) => {
    const selectedTarget = { ...target, kind };
    const associations = kind === "application" ? {} : kind === "claim"
      ? { applicationId: null, applicationRequirementId: null, claimId: recordId, claimRequirementId: requirementId }
      : { applicationId: null, applicationRequirementId: null, travelRequestId: recordId, travelRequirementId: requirementId };
    const exact = document(associations);
    const foreignRecord = kind === "application" ? { applicationId: "other" } : kind === "claim" ? { claimId: "other" } : { travelRequestId: "other" };
    const foreignRequirement = kind === "application" ? { applicationRequirementId: "other" } : kind === "claim" ? { claimRequirementId: "other" } : { travelRequirementId: "other" };
    mocks.list.mockResolvedValue([exact, { ...exact, ...foreignRecord }, { ...exact, ...foreignRequirement }, { ...exact, clientId: "other" }]);

    expect(await listAttachedRequirementDocuments(selectedTarget)).toEqual({ documents: [{ id: documentId, name: exact.name }], canRemove: true });
    expect(mocks.list).toHaveBeenCalledWith(clientId);
  });

  it.each(["Assistant", "Viewer"])("allows authorized %s downloads but offers no removal", async (role) => {
    mocks.actor.mockResolvedValue({ ...admin, role });
    expect(await listAttachedRequirementDocuments(target)).toEqual({ documents: [{ id: documentId, name: document().name }], canRemove: false });
  });

  it("does not read client documents when target resolution is refused", async () => {
    mocks.scope.mockRejectedValue(new RepositoryError("Record not found."));
    await expect(listAttachedRequirementDocuments(target)).rejects.toThrow("Record not found.");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe("atomic checklist removal boundaries", () => {
  it.each(["Assistant", "Viewer"])("refuses real %s before detach or byte cleanup", async (role) => {
    mocks.actor.mockResolvedValue({ ...admin, role, appRole: "admin" });
    await expect(removeRequirementAttachment(target, documentId)).rejects.toThrow("Only an Admin");
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it.each([
    ["missing document", null],
    ["foreign client", document({ clientId: "foreign" })],
    ["foreign record", document({ applicationId: "foreign" })],
    ["foreign requirement", document({ applicationRequirementId: "foreign" })],
  ])("refuses %s without detaching or deleting bytes", async (_label, value) => {
    mocks.find.mockResolvedValue(value);
    await expect(removeRequirementAttachment(target, documentId)).rejects.toThrow("This attachment changed. Refresh and try again.");
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it.each(["This attachment changed. Refresh and try again.", "Another record still uses this attachment. Nothing was removed."])("never removes bytes after a rejected transaction: %s", async (message) => {
    mocks.detach.mockRejectedValue(new RepositoryError(message));
    await expect(removeRequirementAttachment(target, documentId)).rejects.toThrow(message);
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("preserves Inbox originals even if a returned result also carries a path", async () => {
    mocks.detach.mockResolvedValue({ storagePath: path, requirementStatus: "Pending", originalPreserved: true });
    expect(await removeRequirementAttachment(target, documentId)).toEqual({ clientId, removal: { documentId, requirementStatus: "Pending", originalPreserved: true, cleanupFailed: false } });
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("removes only the returned unshared path, after detach has committed", async () => {
    const unsharedPath = `${clientId}/requirements/returned-path.pdf`;
    mocks.detach.mockResolvedValue({ storagePath: unsharedPath, requirementStatus: "Pending", originalPreserved: false });
    const result = await removeRequirementAttachment(target, documentId);
    expect(result.removal).toEqual({ documentId, requirementStatus: "Pending", originalPreserved: false, cleanupFailed: false });
    expect(mocks.removeObject).toHaveBeenCalledExactlyOnceWith(unsharedPath);
    expect(mocks.detach.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeObject.mock.invocationCallOrder[0]);
  });

  it("leaves shared bytes alone and retains an Incomplete result", async () => {
    mocks.detach.mockResolvedValue({ storagePath: null, requirementStatus: "Incomplete", originalPreserved: false });
    expect((await removeRequirementAttachment(target, documentId)).removal.requirementStatus).toBe("Incomplete");
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("reports committed removal with a cleanup warning and no provider-secret leakage", async () => {
    mocks.removeObject.mockRejectedValue(new Error("Storage token sk-secret rejected"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await removeRequirementAttachment(target, documentId)).toEqual({ clientId, removal: { documentId, requirementStatus: "Pending", originalPreserved: false, cleanupFailed: true } });
      expect(log).toHaveBeenCalledWith("Requirement attachment byte cleanup failed", { documentId, storagePath: path });
      expect(JSON.stringify(log.mock.calls)).not.toContain("sk-secret");
    } finally { log.mockRestore(); }
  });
});
