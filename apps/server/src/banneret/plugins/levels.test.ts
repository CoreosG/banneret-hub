import { expect, it } from "vite-plus/test";
import { classify } from "./levels.ts";

it("uses annotations first and handles absent hints conservatively", () => {
  expect(classify({ name: "skills_get", annotations: { readOnlyHint: false } })).toBe("write");
  expect(classify({ name: "lookup", annotations: { readOnlyHint: true } })).toBe("read");
  expect(
    classify({ name: "get", annotations: { readOnlyHint: true, destructiveHint: true } }),
  ).toBe("sensitive");
  expect(classify({ name: "tracker_list_issues" }, "tracker_")).toBe("read");
  expect(classify({ name: "delete_issue" })).toBe("sensitive");
  expect(classify({ name: "sync" })).toBe("write");
  expect(classify({ name: "list_and_publish" })).toBe("write");
});
