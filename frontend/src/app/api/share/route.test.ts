// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "./route";
import { GET } from "./[id]/route";
import { __resetMemStore } from "@/lib/shareStore";

const validPayload = {
  username: "alice",
  period: "blend",
  mode: "artists",
  appetite: "balanced",
  recommendations: [
    {
      name: "Duster",
      stickiness_score: 40,
      conviction_score: 120,
      composite_score: 60,
      total_listeners: 8000,
      top_tags: ["slowcore"],
      source_seeds: [{ name: "Bedhead", percentile: 12 }],
    },
  ],
  computedAt: 1_700_000_000_000,
};

function postReq(body: string): Request {
  return new Request("http://localhost/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function getCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  __resetMemStore();
});

describe("POST /api/share -> GET /api/share/[id]", () => {
  it("roundtrips a byte-identical payload", async () => {
    const body = JSON.stringify(validPayload);
    const postRes = await POST(postReq(body));
    expect(postRes.status).toBe(201);
    const { id } = (await postRes.json()) as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);

    const getRes = await GET(new Request("http://localhost"), getCtx(id));
    expect(getRes.status).toBe(200);
    const text = await getRes.text();
    expect(text).toBe(body); // exact bytes preserved
    expect(JSON.parse(text)).toEqual(validPayload);
  });

  it("returns 404 for an unknown id", async () => {
    const getRes = await GET(new Request("http://localhost"), getCtx("unknown0000"));
    expect(getRes.status).toBe(404);
  });
});

describe("POST /api/share rejects malformed input", () => {
  it("400 on invalid JSON", async () => {
    const res = await POST(postReq("not json"));
    expect(res.status).toBe(400);
  });

  it("400 on a missing required field", async () => {
    const { computedAt, ...rest } = validPayload;
    void computedAt;
    const res = await POST(postReq(JSON.stringify(rest)));
    expect(res.status).toBe(400);
  });

  it("400 on an unknown extra key", async () => {
    const res = await POST(postReq(JSON.stringify({ ...validPayload, evil: true })));
    expect(res.status).toBe(400);
  });

  it("413 on an oversized payload", async () => {
    const huge = {
      ...validPayload,
      recommendations: [{ ...validPayload.recommendations[0], name: "x".repeat(200_000) }],
    };
    const res = await POST(postReq(JSON.stringify(huge)));
    expect(res.status).toBe(413);
  });
});
