import type { ListOptions } from "../types";
import type { ClientPolicyProduct, Policy, NewPolicy, PolicyUpdate } from "./policy.entity";

/** The Policies repository port (same shape as ClientsRepository). */
export interface PoliciesRepository {
  findById(id: string): Promise<Policy | null>;
  /** All policies, joined with client/product/plan names; newest first. */
  list(opts?: ListOptions): Promise<Policy[]>;
  /** Policies belonging to one client; newest first. */
  listByClient(clientId: string): Promise<Policy[]>;
  /**
   * Product names of every policy (any status) for the given clients, newest first per client.
   * Reads are chunked and paged to completion, so nothing is silently truncated; any failure or
   * incomplete read throws instead of returning a partial list. `ownerUserId` scopes to an agent's book.
   */
  listProductsByClientIds(clientIds: string[], opts?: { ownerUserId?: string | null }): Promise<ClientPolicyProduct[]>;
  create(input: NewPolicy): Promise<Policy>;
  update(id: string, input: PolicyUpdate): Promise<Policy>;
}
