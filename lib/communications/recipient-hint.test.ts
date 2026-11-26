import { describe, expect, it } from "vitest";

import { missingRecipientHint } from "./recipient-hint";

describe("missingRecipientHint", () => {
  const base = { recipient: "", contactEmail: null, contactName: "Ana Cruz" };

  it("names the contact when there is no recipient and no email on record", () => {
    expect(missingRecipientHint(base)).toBe("No email on file for Ana Cruz. Enter one, or add it to the client record.");
    expect(missingRecipientHint({ ...base, recipient: "   ", contactEmail: "  " })).not.toBeNull();
  });

  it("stays quiet once the field is filled or the record has an email", () => {
    expect(missingRecipientHint({ ...base, recipient: "ana@example.com" })).toBeNull();
    expect(missingRecipientHint({ ...base, contactEmail: "ana@example.com" })).toBeNull();
  });

  it("stays quiet for a locked recipient", () => {
    expect(missingRecipientHint({ ...base, locked: true })).toBeNull();
  });
});
