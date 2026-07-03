import { describe, it, expect } from "vitest";
import {
  elideOldToolMessages,
  shouldCompact,
  estimateTokens,
  toWireMessages,
  type ConvMsg,
} from "./compaction.js";

function toolMsg(iter: number, text: string): ConvMsg {
  return {
    role: "tool",
    tool_call_id: `c${iter}`,
    name: "web_search",
    content: text,
    iter,
    elidable: true,
    summary: `web_search result ${iter}`,
  };
}

describe("estimateTokens", () => {
  it("estimates ~chars/3.6", () => {
    expect(estimateTokens("a".repeat(360))).toBe(100);
  });
});

describe("elideOldToolMessages", () => {
  it("elides tool messages older than keepIters, leaving recent ones", () => {
    const messages: ConvMsg[] = [
      { role: "system", content: "sys", iter: 0, pinned: true },
      toolMsg(0, "OLD bulky payload ".repeat(50)),
      toolMsg(4, "RECENT payload"),
    ];
    const { messages: out, folded } = elideOldToolMessages(messages, 5, 3);
    expect(folded).toBe(1);
    // iter 0 is older than 5-3=2 -> elided
    expect(out[1].elided).toBe(true);
    expect(out[1].content).toContain("elided");
    // iter 4 is within the keep window -> untouched
    expect(out[2].elided).toBeUndefined();
    expect(out[2].content).toBe("RECENT payload");
  });

  it("does not elide non-elidable or already-elided messages", () => {
    const messages: ConvMsg[] = [
      { role: "assistant", content: "reasoning", iter: 0 },
      { ...toolMsg(0, "x"), elidable: false },
      { ...toolMsg(0, "y"), elided: true },
    ];
    const { folded } = elideOldToolMessages(messages, 10, 3);
    expect(folded).toBe(0);
  });

  it("is pure — original array is not mutated", () => {
    const original = toolMsg(0, "payload");
    const messages: ConvMsg[] = [original];
    elideOldToolMessages(messages, 10, 3);
    expect(original.content).toBe("payload");
    expect(original.elided).toBeUndefined();
  });
});

describe("shouldCompact", () => {
  it("is false for a small conversation", () => {
    const messages: ConvMsg[] = [{ role: "user", content: "hi", iter: 0 }];
    expect(shouldCompact(messages)).toBe(false);
  });

  it("is true once past the soft cap", () => {
    const big = "x".repeat(300_000);
    const messages: ConvMsg[] = [{ role: "user", content: big, iter: 0 }];
    expect(shouldCompact(messages)).toBe(true);
  });

  it("respects a custom soft cap", () => {
    const messages: ConvMsg[] = [{ role: "user", content: "x".repeat(3600), iter: 0 }];
    // 3600 chars ~= 1000 tokens
    expect(shouldCompact(messages, 500)).toBe(true);
    expect(shouldCompact(messages, 5000)).toBe(false);
  });
});

describe("toWireMessages", () => {
  it("strips orchestrator-only meta fields", () => {
    const messages: ConvMsg[] = [
      { role: "assistant", content: "hi", iter: 3, elidable: true, summary: "s", pinned: true },
    ];
    const wire = toWireMessages(messages);
    expect(wire[0]).toEqual({ role: "assistant", content: "hi" });
    expect("iter" in wire[0]).toBe(false);
    expect("summary" in wire[0]).toBe(false);
  });

  it("keeps tool_calls / tool_call_id / name", () => {
    const messages: ConvMsg[] = [
      {
        role: "assistant",
        content: null,
        iter: 0,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", name: "f", content: "out", iter: 0 },
    ];
    const wire = toWireMessages(messages);
    expect(wire[0].tool_calls).toBeDefined();
    expect(wire[1]).toEqual({ role: "tool", content: "out", tool_call_id: "c1", name: "f" });
  });
});
