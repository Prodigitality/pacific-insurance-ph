import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequirementTarget } from "@/lib/documents/requirement-attachment.types";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), access: vi.fn(), list: vi.fn(), remove: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/actions/context", () => ({ getActor: mocks.actor }));
vi.mock("@/lib/auth/agent-scope", () => ({
  assertRecordAccess: mocks.access,
  RecordAccessError: class extends Error { constructor() { super("Record not found."); } },
}));
vi.mock("@/lib/documents/requirement-attachments", () => ({
  listAttachedRequirementDocuments: mocks.list,
  removeRequirementAttachment: mocks.remove,
  requirementAttachmentError: () => "The attachment is temporarily unavailable. Please try again.",
  attachRequirementDocument: vi.fn(), beginRequirementAttachmentUpload: vi.fn(), listRequirementEmailAttachments: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => { throw new Error("Actions must use the service/repository boundary."); } }));

import { RecordAccessError } from "@/lib/auth/agent-scope";
import { listAttachedRequirementDocumentsAction, removeRequirementAttachmentAction } from "./requirement-attachment-actions";

const target: RequirementTarget = { kind: "application", recordId: "application-id", requirementId: "requirement-id" };
const removal = { documentId: "document-id", requirementStatus: "Pending" as const, originalPreserved: false, cleanupFailed: false };
const admin = { id: "admin-id", role: "Admin", fullName: "QA Admin" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue(admin);
  mocks.access.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ documents: [{ id: removal.documentId, name: "Synthetic.pdf" }], canRemove: true });
  mocks.remove.mockResolvedValue({ clientId: "client-id", removal });
});

describe("checklist attachment actions", () => {
  it.each(["Assistant", "Viewer"])("refuses real %s removal without invoking the service or invalidating caches", async (role) => {
    mocks.actor.mockResolvedValue({ ...admin, role });
    expect(await removeRequirementAttachmentAction(target, removal.documentId)).toEqual({ ok: false, error: "Only an Admin can remove a checklist attachment." });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("refuses an inactive or unauthenticated actor before touching records", async () => {
    mocks.actor.mockRejectedValue(new Error("An active account is required."));
    expect((await removeRequirementAttachmentAction(target, removal.documentId)).ok).toBe(false);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each(["application", "document"])("blocks a foreign %s and leaves state unchanged", async (blockedKind) => {
    mocks.access.mockImplementation(async (kind: string) => { if (kind === blockedKind) throw new RecordAccessError(); });
    expect(await removeRequirementAttachmentAction(target, removal.documentId)).toEqual({ ok: false, error: "Record not found." });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("does not expose or list a foreign target", async () => {
    mocks.access.mockRejectedValue(new RecordAccessError());
    expect(await listAttachedRequirementDocumentsAction(target)).toEqual({ ok: false, error: "Record not found." });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns a database failure without publishing a removed result", async () => {
    mocks.remove.mockRejectedValue(new Error("private database error"));
    expect(await removeRequirementAttachmentAction(target, removal.documentId)).toEqual({ ok: false, error: "The attachment is temporarily unavailable. Please try again." });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["application", "/applications"], ["claim", "/claims"], ["travel", "/travel"],
  ] as const)("refreshes the %s checklist and client after committed removal, including a cleanup warning", async (kind, modulePath) => {
    mocks.remove.mockResolvedValue({ clientId: "client-id", removal: { ...removal, cleanupFailed: true } });
    expect(await removeRequirementAttachmentAction({ ...target, kind }, removal.documentId)).toEqual({ ok: true, data: { ...removal, cleanupFailed: true } });
    expect(mocks.revalidate.mock.calls).toEqual([["/documents"], [modulePath], ["/clients/client-id"]]);
  });
});

it("keeps the committed removal result when cache invalidation fails", async () => {
  mocks.revalidate.mockImplementation(() => { throw new Error("cache unavailable"); });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await removeRequirementAttachmentAction(target, removal.documentId)).toEqual({ ok: true, data: removal });
    expect(mocks.revalidate).toHaveBeenCalledTimes(3);
  } finally { log.mockRestore(); }
});
