import { describe, it, expect } from "vitest";
import { canPersistActions, canFireRecEvent } from "./capability";
import type { Session } from "./session";

const session: Session = { session_token: "t", username: "alice", user_id: "u-1" };

// Hidden-when-unsupported matrix: save/dismiss UI must render if and only if
// ALL THREE of {session, persistence:true, rec_id present} hold. Every other
// combination must hide the UI — never a silently no-op button.
describe("canPersistActions — hidden-when-unsupported matrix", () => {
  const cases: [string, Session | null, boolean | undefined, string | null | undefined, boolean][] = [
    ["logged in + persistence:true + rec_id  -> SHOW", session, true, "rec-1", true],
    ["logged out + persistence:true + rec_id -> hidden", null, true, "rec-1", false],
    ["logged in + persistence:false + rec_id -> hidden", session, false, "rec-1", false],
    ["logged in + persistence:true + no rec_id -> hidden", session, true, null, false],
    ["logged in + persistence:true + undefined rec_id -> hidden", session, true, undefined, false],
    ["logged in + persistence:undefined + rec_id -> hidden", session, undefined, "rec-1", false],
    ["logged out + persistence:false + no rec_id -> hidden", null, false, null, false],
    ["logged out + persistence:false + no rec_id (all defaults) -> hidden", null, undefined, undefined, false],
  ];

  it.each(cases)("%s", (_label, sess, persistence, recId, expected) => {
    expect(canPersistActions(sess, persistence, recId)).toBe(expected);
  });
});

describe("canFireRecEvent", () => {
  it("true whenever rec_id is a non-empty string, regardless of auth", () => {
    expect(canFireRecEvent("rec-1")).toBe(true);
  });

  it("false when rec_id is null, undefined, or empty", () => {
    expect(canFireRecEvent(null)).toBe(false);
    expect(canFireRecEvent(undefined)).toBe(false);
    expect(canFireRecEvent("")).toBe(false);
  });
});
