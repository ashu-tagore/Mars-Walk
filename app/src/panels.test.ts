import { describe, expect, it } from "vitest";
import { tagDescription } from "./panels";
import type { SiteMeta } from "./store";

// Only `constants` is read by tagDescription.
const META = {
  constants: {
    RESERVE_FRACTION: { value: "0.25", status: "ASSUMPTION", source: "our choice" },
    EVA_DURATION_H: { value: "6 (range 4 to 8)", status: "ASSUMPTION", source: "our choice" },
    GRAVITY_MARS: { value: "3.71", status: "SOURCED", source: "NASA fact sheet" },
  },
} as unknown as SiteMeta;

describe("tagDescription", () => {
  it("returns null when no constant is an ASSUMPTION", () => {
    expect(tagDescription(META, ["GRAVITY_MARS"], {})).toBeNull();
  });

  it("describes the documented values when nothing is changed", () => {
    const tag = tagDescription(META, ["RESERVE_FRACTION", "GRAVITY_MARS"], {});
    expect(tag?.text).toBe("assumption");
    expect(tag?.changed).toBe(false);
    expect(tag?.title).toContain("RESERVE_FRACTION = 0.25: our choice");
    expect(tag?.title).not.toContain("GRAVITY_MARS");
  });

  it("shows the user's value and the documented value after a settings change", () => {
    const tag = tagDescription(META, ["RESERVE_FRACTION", "EVA_DURATION_H"], { EVA_DURATION_H: 5 });
    expect(tag?.text).toBe("assumption, changed");
    expect(tag?.changed).toBe(true);
    expect(tag?.title).toContain("EVA_DURATION_H = 5 (your setting; docs: 6 (range 4 to 8))");
    expect(tag?.title).toContain("RESERVE_FRACTION = 0.25: our choice");
  });

  it("ignores a setting that is not one of the tag's constants", () => {
    const tag = tagDescription(META, ["RESERVE_FRACTION"], { EVA_DURATION_H: 5 });
    expect(tag?.changed).toBe(false);
  });
});
