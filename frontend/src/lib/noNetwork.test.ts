import { describe, expect, it } from "vitest";

describe("test setup", () => {
  it("blocks unmocked network calls", async () => {
    expect(vi_isMock(globalThis.fetch)).toBe(true);
    await expect(fetch("http://localhost:8080/api/anything")).rejects.toThrow(/unmocked network call/);
  });
});

function vi_isMock(f: unknown): boolean {
  return typeof f === "function" && "mock" in (f as object);
}
