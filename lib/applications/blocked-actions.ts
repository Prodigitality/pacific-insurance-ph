import { requirementLabelText } from "./requirement-sections";

/** What a blocked footer action lists: a label and, when a control resolves it, that control's DOM id. */
export interface ActionBlocker {
  label: string;
  target?: string;
}

/** DOM id of the medical review step's body, where the clearance is entered. */
export const MEDICAL_REVIEW_TARGET = "app-medical-review";

/** Chips shown before the rest collapse into "+N more". */
export const MAX_REQUIREMENT_BLOCKERS = 5;

interface RequirementLike {
  id: string;
  documentName: string;
  appliesTo?: string | null;
  isRequired: boolean;
  status: string;
}

/**
 * The one definition of "still outstanding": a required item the client has not yet satisfied.
 * Optional items never count, and an item turned on with "Count as required" does. The workflow
 * progress, the footers' disabled state and the "still needed" chips all derive from this.
 */
export const isOutstandingRequirement = (item: Pick<RequirementLike, "isRequired" | "status">): boolean =>
  item.isRequired && (item.status === "Pending" || item.status === "Incomplete");

/**
 * One chip per outstanding required requirement, named by its display title (owner included, so two
 * people's "Valid government-issued ID" stay distinguishable) and jumping to its row. At most `cap`
 * chips; the remainder collapse into "+N more", which jumps to the first remaining row.
 */
export function requirementBlockers(items: readonly RequirementLike[], cap = MAX_REQUIREMENT_BLOCKERS): Required<ActionBlocker>[] {
  const outstanding = items.filter(isOutstandingRequirement);
  const seen = new Map<string, number>();
  const named = outstanding.map((item) => {
    const base = requirementLabelText(item);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    // Chips are keyed by label, so two identical names must still differ.
    return { label: count === 1 ? base : `${base} (${count})`, target: `requirement-${item.id}` };
  });
  if (named.length <= cap) return named;
  const rest = named.slice(cap);
  return [...named.slice(0, cap), { label: `+${rest.length} more`, target: rest[0].target }];
}

/**
 * Why the medical review step's Continue is greyed out. Only a pending review blocks (a review that is
 * not required or already cleared never does), mirroring the workflow's `medicalDone` rule.
 */
export function medicalReviewBlockers(review: { status: string; canClear: boolean; blockers: readonly string[] }): ActionBlocker[] {
  if (review.status !== "Pending") return [];
  return [
    ...(review.blockers.length ? [{ label: `${review.blockers.length} medical item${review.blockers.length === 1 ? "" : "s"} to verify`, target: MEDICAL_REVIEW_TARGET }] : []),
    review.canClear
      ? { label: "Clear the medical review", target: MEDICAL_REVIEW_TARGET }
      : { label: "Admin or Staff must clear the medical review" },
  ];
}
