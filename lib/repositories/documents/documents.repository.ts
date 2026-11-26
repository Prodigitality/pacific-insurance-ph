import type { ListOptions, ListParams, Paginated } from "../types";
import type {
  DocumentRecord,
  DocumentRecordUpdate,
  NewDocumentRecord,
  ProposalReceiptInput,
  ProposalReplacementInput,
} from "./document.entity";

/** The Documents repository port. Follows the canonical repository shape. */
export interface DocumentsRepository {
  /** `ownerUserId` keeps only documents whose client is assigned to that agent (Phase J9). */
  list(params?: ListParams & Pick<ListOptions, "ownerUserId">): Promise<Paginated<DocumentRecord>>;
  listWithClientName(params?: ListParams & Pick<ListOptions, "ownerUserId">): Promise<Paginated<DocumentRecord & { clientName: string | null }>>;
  listByClient(clientId: string): Promise<DocumentRecord[]>;
  listByTravelRequest(travelRequestId: string): Promise<DocumentRecord[]>;
  findById(id: string): Promise<DocumentRecord | null>;
  create(input: NewDocumentRecord): Promise<DocumentRecord>;
  registerProposalReceipt(input: ProposalReceiptInput): Promise<DocumentRecord>;
  /**
   * File a corrected proposal PDF and retire the client's prior active proposals as Replaced, in
   * one transaction under the client lock (`replace_proposal_pdf`), serialized with removal and
   * receipt. Fails without creating a document when the proposal is no longer received.
   */
  replaceProposal(input: ProposalReplacementInput): Promise<DocumentRecord>;
  /**
   * L11 / DL9: remove the lead's current proposal PDF and return proposal tracking to Requested
   * in one locked transaction (`delete_proposal_pdf`). An Inbox-filed original is retired as
   * Replaced and kept (`originalPreserved`); a direct upload's row is deleted and its path is
   * returned only when no other record references those bytes. The caller removes the Storage
   * object after this resolves.
   */
  deleteProposal(actorId: string, clientId: string, documentId: string): Promise<{ storagePath: string | null; originalPreserved: boolean }>;
  update(id: string, input: DocumentRecordUpdate): Promise<DocumentRecord>;
  delete(id: string): Promise<void>;
}
