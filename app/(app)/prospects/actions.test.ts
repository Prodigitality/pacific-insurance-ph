import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActor: vi.fn(),
  assertRecordAccess: vi.fn(),
  recordActivity: vi.fn(),
  recordAudit: vi.fn(),
  revalidatePath: vi.fn(),
  removeObject: vi.fn(),
  documents: { deleteProposal: vi.fn() },
  clients: { findById: vi.fn(), update: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/actions/context", () => ({ getActor: mocks.getActor }));
vi.mock("@/lib/auth/agent-scope", () => ({ assertRecordAccess: mocks.assertRecordAccess }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: mocks.recordActivity }));
vi.mock("@/lib/audit/log", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/supabase/storage", () => ({ removeObject: mocks.removeObject }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => {
    throw new Error("The action must go through the repository layer.");
  },
}));
vi.mock("@/lib/repositories/documents", () => ({ getDocumentsRepository: () => mocks.documents }));
vi.mock("@/lib/repositories/clients", () => ({ getClientsRepository: () => mocks.clients }));
vi.mock("@/lib/repositories/dependents", () => ({ getDependentsRepository: vi.fn() }));
vi.mock("@/lib/repositories/integration-settings", () => ({ getIntegrationSettingsRepository: vi.fn() }));
vi.mock("@/lib/documents/uploaded-pdf", () => ({ registerUploadedPdf: vi.fn(), registerUploadedProposalReceipt: vi.fn() }));
vi.mock("@/lib/queries/lead-status-inference", () => ({ withInferredLeadStatus: vi.fn() }));
vi.mock("@/lib/products/active-products", () => ({ checkProductInterest: vi.fn() }));

import { deleteProposalPdfAction } from "./actions";

const CLIENT_ID = "client-1";
const DOCUMENT_ID = "doc-proposal";
const ADMIN = { id: "admin-1", fullName: "Matt", role: "Admin" };
const STORAGE_PATH = "client-1/proposal-upload.pdf";

const remove = () => deleteProposalPdfAction(CLIENT_ID, DOCUMENT_ID);

/** Nothing on the lead, its files or the caches may change. */
function expectNoEffects() {
  expect(mocks.removeObject).not.toHaveBeenCalled();
  expect(mocks.clients.update).not.toHaveBeenCalled();
  expect(mocks.recordActivity).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActor.mockResolvedValue(ADMIN);
  mocks.assertRecordAccess.mockResolvedValue(undefined);
  mocks.removeObject.mockResolvedValue(undefined);
  mocks.recordActivity.mockResolvedValue(undefined);
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe("deleteProposalPdfAction authorization", () => {
  it.each(["Assistant", "Viewer"])("refuses a real %s before touching the proposal", async (role) => {
    mocks.getActor.mockResolvedValue({ ...ADMIN, role });

    const result = await remove();

    expect(result).toEqual({ ok: false, error: "Only an Admin can delete a proposal PDF." });
    expect(mocks.documents.deleteProposal).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it("refuses a record outside the actor's scope without deleting", async () => {
    mocks.assertRecordAccess.mockRejectedValue(new Error("Record not found."));

    const result = await remove();

    expect(result).toEqual({ ok: false, error: "Record not found." });
    expect(mocks.documents.deleteProposal).not.toHaveBeenCalled();
    expectNoEffects();
  });
});

describe("deleteProposalPdfAction database outcomes", () => {
  it.each([
    ["a stale or wrong-client proposal", "This proposal changed since the page loaded, so nothing was deleted. Refresh and try again."],
    ["another active proposal", "This lead has another active proposal PDF, so nothing was deleted. Refresh and try again."],
    ["a restrictive FK conflict", "Another record still uses this proposal PDF, so nothing was deleted."],
  ])("reports %s and never removes bytes or resets the lead", async (_case, message) => {
    mocks.documents.deleteProposal.mockRejectedValue(new Error(message));

    const result = await remove();

    expect(result).toEqual({ ok: false, error: message });
    expect(mocks.documents.deleteProposal).toHaveBeenCalledWith(ADMIN.id, CLIENT_ID, DOCUMENT_ID);
    expectNoEffects();
  });

  it("keeps an Inbox original: success without any Storage removal", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: null, originalPreserved: true });

    const result = await remove();

    expect(result).toEqual({ ok: true, data: { originalPreserved: true } });
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(mocks.clients.update).not.toHaveBeenCalled();
    expect(mocks.recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      scopeType: "client", scopeId: CLIENT_ID, activityType: "lead.proposal", actorId: ADMIN.id,
    }));
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
  });

  it("removes exactly the returned path of a direct upload, after the database commits", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: STORAGE_PATH, originalPreserved: false });

    const result = await remove();

    expect(result).toEqual({ ok: true, data: { originalPreserved: false } });
    expect(mocks.removeObject).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).toHaveBeenCalledWith(STORAGE_PATH);
    expect(mocks.documents.deleteProposal.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeObject.mock.invocationCallOrder[0]);
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
  });

  it("leaves shared bytes alone when the transaction returns no path", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: null, originalPreserved: false });

    const result = await remove();

    expect(result).toEqual({ ok: true, data: { originalPreserved: false } });
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });
});

describe("deleteProposalPdfAction Storage cleanup failure", () => {
  it("reports a partial outcome, never success, and records the orphaned path", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: STORAGE_PATH, originalPreserved: false });
    mocks.removeObject.mockRejectedValue(new Error("Storage remove failed: token sk-secret rejected"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await remove();

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, recordRemoved: true });
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/record was removed.*could not be deleted from storage/);
    expect(result.error).not.toContain("sk-secret");
    expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ADMIN.id,
      action: "proposal.file_cleanup_failed",
      recordId: DOCUMENT_ID,
      newValue: { clientId: CLIENT_ID, storagePath: STORAGE_PATH },
    }));
    expect(JSON.stringify([mocks.recordAudit.mock.calls, logged.mock.calls])).not.toContain("sk-secret");
    // The record did change, so the profile must refresh rather than keep showing the PDF.
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
    logged.mockRestore();
  });
});
