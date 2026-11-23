import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sanitizeText, sanitizedTextField } from "../../src/lib/sanitize-text";
import {
  createExpenseSchema,
  updateExpenseSchema,
} from "../../src/validations/expense";
import {
  createGroupSchema,
  updateGroupSchema,
} from "../../src/schemas/groups";
import { treasuryMultisigProposalPayloadSchema } from "../../src/validations/treasury";

const cc = (code: number) => String.fromCharCode(code);
const NUL = cc(0x00);
const BEL = cc(0x07);
const ESC = cc(0x1b);
const DEL = cc(0x7f);
const C1 = cc(0x9f);
const BIDI_OVERRIDE = cc(0x202e);
const ZWSP = cc(0x200b);
const BOM = cc(0xfeff);

const expenseBase = {
  amount: "10.5",
  assetCode: "XLM",
  splitType: "equal",
  shares: [{ userId: "user_1" }],
};

const proposalBase = {
  destination: Keypair.random().publicKey(),
  amount: "5",
  assetCode: "XLM",
};

describe("sanitizeText", () => {
  it("trims leading and trailing whitespace", () => {
    expect(sanitizeText("  Dinner at Luigi's  ")).toBe("Dinner at Luigi's");
    expect(sanitizeText("\t\tTeam offsite\n")).toBe("Team offsite");
  });

  it("strips HTML tags but keeps the inner text", () => {
    expect(sanitizeText("<script>alert(1)</script>pay rent")).toBe(
      "alert(1)pay rent"
    );
    expect(sanitizeText("<b>Trip</b> to <i>Lisbon</i>")).toBe("Trip to Lisbon");
    expect(sanitizeText('click <a href="http://evil">here</a>')).toBe(
      "click here"
    );
    expect(sanitizeText("line<br/>break")).toBe("linebreak");
  });

  it("strips HTML comments", () => {
    expect(sanitizeText("hello <!-- hidden -->world")).toBe("hello world");
  });

  it("strips dangerous control characters", () => {
    const dirty = `Dinner${NUL} at${BEL} Luigi's${ESC}[31m${DEL}${C1}`;
    expect(sanitizeText(dirty)).toBe("Dinner at Luigi's[31m");
  });

  it("strips invisible bidi overrides and zero-width characters", () => {
    expect(
      sanitizeText(`${BIDI_OVERRIDE}evil${ZWSP}${BOM} text`)
    ).toBe("evil text");
  });

  it("preserves newlines and tabs inside the text", () => {
    expect(sanitizeText("line one\nline two\tend")).toBe(
      "line one\nline two\tend"
    );
  });

  it("preserves emojis including ZWJ sequences and skin tones", () => {
    const emoji = "Family 👨‍👩‍👧‍👦 party 🎉🏽";
    expect(sanitizeText(`  ${emoji}  `)).toBe(emoji);
  });

  it("preserves international text and standard punctuation", () => {
    const localized = "Dîner à Paris — 東京, 100% café! ¿Qué tal?";
    expect(sanitizeText(localized)).toBe(localized);
  });

  it("does not treat comparison operators as markup", () => {
    expect(sanitizeText("budget < 100 and > 50")).toBe("budget < 100 and > 50");
    expect(sanitizeText("love <3")).toBe("love <3");
  });
});

describe("sanitizedTextField", () => {
  it("validates length on the cleaned value", () => {
    const schema = sanitizedTextField({ min: 1, max: 5 });
    expect(schema.parse("  abc  ")).toBe("abc");
    expect(schema.parse("abcde   ")).toBe("abcde");
    expect(() => schema.parse("abcdef")).toThrow();
  });

  it("rejects a value that is empty after sanitization", () => {
    const schema = sanitizedTextField({ min: 1, minMessage: "is required" });
    expect(() => schema.parse("   ")).toThrow(/is required/);
    expect(() => schema.parse("<b></b>")).toThrow(/is required/);
  });

  it("supports optional and nullable chains", () => {
    const optional = sanitizedTextField({ max: 10 }).optional();
    expect(optional.parse(undefined)).toBeUndefined();
    const nullable = sanitizedTextField({ max: 10 }).nullable();
    expect(nullable.parse(null)).toBeNull();
  });
});

describe("createExpenseSchema sanitization", () => {
  it("trims the title and description", () => {
    const parsed = createExpenseSchema.parse({
      ...expenseBase,
      title: "  Dinner  ",
      description: "  with the team  ",
    });
    expect(parsed.title).toBe("Dinner");
    expect(parsed.description).toBe("with the team");
  });

  it("strips HTML and control characters from the description", () => {
    const parsed = createExpenseSchema.parse({
      ...expenseBase,
      title: "Dinner",
      description: `<b>Team</b> dinner${NUL}${BEL} at Luigi's`,
    });
    expect(parsed.description).toBe("Team dinner at Luigi's");
  });

  it("rejects a title that is empty after sanitization", () => {
    const result = createExpenseSchema.safeParse({
      ...expenseBase,
      title: " \t ",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a max-length title once padding is trimmed", () => {
    const parsed = createExpenseSchema.parse({
      ...expenseBase,
      title: `  ${"a".repeat(80)}  `,
    });
    expect(parsed.title).toBe("a".repeat(80));
  });

  it("accepts localized text and emojis unchanged", () => {
    const title = "Café 東京 🎉";
    const description = "Soirée à Paris — 100% génial 👨‍👩‍👧‍👦";
    const parsed = createExpenseSchema.parse({
      ...expenseBase,
      title,
      description,
    });
    expect(parsed.title).toBe(title);
    expect(parsed.description).toBe(description);
  });
});

describe("updateExpenseSchema sanitization", () => {
  it("trims and sanitizes provided fields", () => {
    const parsed = updateExpenseSchema.parse({
      title: "  New title  ",
      description: `<i>note</i>${ESC}`,
    });
    expect(parsed.title).toBe("New title");
    expect(parsed.description).toBe("note");
  });

  it("keeps an explicit null description", () => {
    expect(updateExpenseSchema.parse({ description: null }).description).toBeNull();
  });

  it("rejects a whitespace-only title", () => {
    expect(updateExpenseSchema.safeParse({ title: "   " }).success).toBe(false);
  });
});

describe("createGroupSchema sanitization", () => {
  it("trims and sanitizes the name and description", () => {
    const parsed = createGroupSchema.parse({
      name: "  <b>Trip</b> to Lisbon  ",
      description: `  Summer${BEL} plans  `,
    });
    expect(parsed.name).toBe("Trip to Lisbon");
    expect(parsed.description).toBe("Summer plans");
  });

  it("rejects a name that is empty after sanitization", () => {
    const result = createGroupSchema.safeParse({ name: " <i></i> " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("name is required");
    }
  });

  it("preserves localized names and emojis", () => {
    const parsed = createGroupSchema.parse({ name: "Équipe 東京 🚀" });
    expect(parsed.name).toBe("Équipe 東京 🚀");
  });

  it("keeps a null description", () => {
    expect(
      createGroupSchema.parse({ name: "Trip", description: null }).description
    ).toBeNull();
  });
});

describe("updateGroupSchema sanitization", () => {
  it("trims and sanitizes the name and description", () => {
    const parsed = updateGroupSchema.parse({
      name: `  Renamed${NUL} group  `,
      description: "  <script>x</script>updated  ",
    });
    expect(parsed.name).toBe("Renamed group");
    expect(parsed.description).toBe("xupdated");
  });

  it("rejects a whitespace-only name", () => {
    expect(updateGroupSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});

describe("treasury proposal description sanitization", () => {
  it("trims and strips markup from the multisig proposal description", () => {
    const parsed = treasuryMultisigProposalPayloadSchema.parse({
      ...proposalBase,
      description: "  <b>pay March rent</b>  ",
    });
    expect(parsed.description).toBe("pay March rent");
  });

  it("rejects a description that is too long after cleaning", () => {
    const result = treasuryMultisigProposalPayloadSchema.safeParse({
      ...proposalBase,
      description: "a".repeat(281),
    });
    expect(result.success).toBe(false);
  });

  it("preserves emojis and international characters", () => {
    const description = "Paiement loyer 🏠 — 東京";
    const parsed = treasuryMultisigProposalPayloadSchema.parse({
      ...proposalBase,
      description,
    });
    expect(parsed.description).toBe(description);
  });
});
