/**
 * Hint shown under the composer's Recipient field when nothing can fill it: the field is empty
 * and the contact has no email on record. It never blocks sending — the existing "recipient is
 * required" readiness check still decides that — it only explains why the field started empty.
 * A locked recipient (Pacific Cross contact) is chosen elsewhere, so it never needs the hint.
 */
export function missingRecipientHint(input: {
  recipient: string;
  contactEmail: string | null | undefined;
  contactName: string;
  locked?: boolean;
}): string | null {
  if (input.locked || input.recipient.trim() || input.contactEmail?.trim()) return null;
  return `No email on file for ${input.contactName}. Enter one, or add it to the client record.`;
}
