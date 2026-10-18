/**
 * DW-6.1: the shared collection-name validator used by data_collection and data_rows.
 */

import { describe, it, expect } from "bun:test";
import { assertCollectionName, isValidCollectionName } from "./site-data-types.ts";

describe("DW-6.1: assertCollectionName", () => {
  it("test_DW_6_1_assert_collection_name_returns_valid_names", () => {
    for (const ok of ["votes", "a", "a-b-1", "x".repeat(40)]) expect(assertCollectionName(ok)).toBe(ok);
  });

  it("test_DW_6_1_assert_collection_name_rejects_with_one_message", () => {
    const msg = (n: string) => `Invalid collection name '${n}': use 1-40 lowercase letters, digits and hyphens (no leading/trailing hyphen).`;
    for (const bad of ["", "Bad", "_me", "-a", "a-", "a_b", "../x", "x".repeat(41)]) {
      expect(isValidCollectionName(bad)).toBe(false);
      expect(() => assertCollectionName(bad)).toThrow(msg(bad));
    }
  });
});
