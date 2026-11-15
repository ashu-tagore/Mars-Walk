// CLAUDE.md: never invent a constant. Every constant the engine exports has a docs/assumptions.md row
// with the same name and value (REVIEW.md F-09). The pipeline has the same check in tests/test_outputs.py.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as constants from "../src/constants";

const docPath = fileURLToPath(new URL("../../docs/assumptions.md", import.meta.url));
// A named table row: | NAME | value | status | source or reason |
const ROW = /^\| ([A-Z][A-Z0-9_]+) \| (.+?) \| (.+?) \| (.+) \|$/gm;
const NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

function docValues(): Map<string, string> {
  const rows = new Map<string, string>();
  for (const match of readFileSync(docPath, "utf8").matchAll(ROW)) rows.set(match[1], match[2]);
  return rows;
}

// True when the Value text holds the code value: a number token, true/false, or every item of a list.
function valueInText(value: unknown, text: string): boolean {
  if (typeof value === "boolean") return text.toLowerCase().includes(String(value));
  if (Array.isArray(value)) return value.every((item) => text.includes(String(item)));
  const numbers = (text.replace(/,/g, "").match(NUMBER) ?? []).map(Number);
  return numbers.some((number) => Math.abs(number - (value as number)) <= 1e-9 * Math.max(1, Math.abs(number)));
}

describe("engine constants match docs/assumptions.md", () => {
  const rows = docValues();
  for (const [name, value] of Object.entries(constants)) {
    it(name, () => {
      const text = rows.get(name);
      expect(text, `${name} has no row in docs/assumptions.md`).toBeDefined();
      expect(valueInText(value, text as string), `${name} = ${String(value)}, docs/assumptions.md says "${text}"`).toBe(true);
    });
  }

  it("the check itself rejects a wrong value", () => {
    expect(valueInText(21, "20")).toBe(false);
    expect(valueInText(true, "false")).toBe(false);
    expect(valueInText(["habitat", "rover"], "habitat")).toBe(false);
  });
});
