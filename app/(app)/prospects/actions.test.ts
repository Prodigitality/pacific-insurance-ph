import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActor: vi.fn(),
  assertRecordAccess: vi.fn(),
  recordActivity: vi.fn(),
  recordAudit: vi.fn(),
  revalidatePath: vi.fn(),
  removeObject: vi.fn(),
  documents: { deleteProposal: vi.fn(), create: vi.fn(), update: vi.fn(), listByClient: vi.fn() },
  clients: { findById: vi.fn(), update: vi.fn() },
  uploaded: { registerUploadedPdf: vi.fn(), registerUploadedProposalReceipt: vi.fn(), registerUploadedProposalReplacement: vi.fn() },
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
vi.mock("@/lib/documents/uploaded-pdf", () => mocks.uploaded);
vi.mock("@/lib/queries/lead-status-inference", () => ({ withInferredLeadStatus: vi.fn() }));
vi.mock("@/lib/products/active-products", () => ({ checkProductInterest: vi.fn() }));

import { deleteProposalPdfAction, replaceProposalPdfAction } from "./actions";

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

  it("stays an explicit partial outcome when the cleanup audit and activity also fail", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: STORAGE_PATH, originalPreserved: false });
    mocks.removeObject.mockRejectedValue(new Error("Storage down"));
    mocks.recordAudit.mockRejectedValue(new Error("audit down"));
    mocks.recordActivity.mockRejectedValue(new Error("activity down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await remove();

    expect(result).toMatchObject({ ok: false, recordRemoved: true });
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
    logged.mockRestore();
  });
});

describe("deleteProposalPdfAction follow-up failures after the database commit", () => {
  it("still reports the completed removal and refreshes when the activity entry fails", async () => {
    mocks.documents.deleteProposal.mockResolvedValue({ storagePath: STORAGE_PATH, originalPreserved: false });
    mocks.recordActivity.mockRejectedValue(new Error("activity down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await remove();

    expect(result).toEqual({ ok: true, data: { originalPreserved: false } });
    expect(mocks.removeObject).toHaveBeenCalledWith(STORAGE_PATH);
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
    logged.mockRestore();
  });
});

describe("replaceProposalPdfAction", () => {
  const UPLOAD_PATH = "client-1/0b6f3c3e-2f7a-4c1e-9a43-5b1f4d7c2a10.pdf";
  const lead = (overrides: Record<string, unknown> = {}) => ({
    id: CLIENT_ID, fullName: "Ana Cruz", lifecycleStage: "Lead", proposalStatus: "Received", productInterest: "Select", ...overrides,
  });
  const replace = () => replaceProposalPdfAction(CLIENT_ID, UPLOAD_PATH, "corrected.pdf");

  /** The old non-atomic path: a separate insert followed by independent status updates. */
  function expectNoLegacyWrites() {
    expect(mocks.uploaded.registerUploadedPdf).not.toHaveBeenCalled();
    expect(mocks.documents.create).not.toHaveBeenCalled();
    expect(mocks.documents.update).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    mocks.getActor.mockResolvedValue({ id: "staff-1", fullName: "Eman", role: "Assistant" });
    mocks.clients.findById.mockResolvedValue(lead());
  });

  it("files the replacement through the single locked transaction", async () => {
    mocks.uploaded.registerUploadedProposalReplacement.mockResolvedValue({ id: "doc-new", name: "Illustrative proposal — Select (corrected.pdf)" });

    const result = await replace();

    expect(result).toEqual({ ok: true, data: { id: "doc-new", name: "Illustrative proposal — Select (corrected.pdf)" } });
    expect(mocks.uploaded.registerUploadedProposalReplacement).toHaveBeenCalledWith({
      clientId: CLIENT_ID, actorId: "staff-1", name: "Illustrative proposal — Select (corrected.pdf)", storagePath: UPLOAD_PATH,
    });
    expectNoLegacyWrites();
    expect(mocks.clients.update).not.toHaveBeenCalled();
    for (const path of ["/prospects", `/clients/${CLIENT_ID}`, "/documents"]) expect(mocks.revalidatePath).toHaveBeenCalledWith(path);
  });

  it("reports a removal that won the race and creates no document", async () => {
    const message = "This proposal changed since the page loaded (it may have been deleted), so nothing was replaced. Refresh and try again.";
    mocks.uploaded.registerUploadedProposalReplacement.mockRejectedValue(new Error(message));

    const result = await replace();

    expect(result).toEqual({ ok: false, error: message });
    expectNoLegacyWrites();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["already back at Requested", { proposalStatus: "Requested" }],
    ["no longer a Lead", { lifecycleStage: "Client" }],
  ])("refuses a lead %s before filing anything", async (_case, overrides) => {
    mocks.clients.findById.mockResolvedValue(lead(overrides));

    const result = await replace();

    expect(result.ok).toBe(false);
    expect(mocks.uploaded.registerUploadedProposalReplacement).not.toHaveBeenCalled();
    expectNoLegacyWrites();
  });
});
