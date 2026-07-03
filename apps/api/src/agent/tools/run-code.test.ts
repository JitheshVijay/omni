import { describe, it, expect } from "vitest";
import { classifyRunCode, runCodeTool, RUN_CODE_PARAMETERS } from "./run-code.js";
import { effectiveKind, DESTRUCTIVE_LABEL } from "./types.js";

// Pure classification / metadata only — no Deno spawn (that needs a live
// runtime and is exercised in the vertical-slice smoke test instead).
describe("run_code classification", () => {
  it("is write_internal without network", () => {
    expect(classifyRunCode({ code: "console.log(1)" })).toBe("write_internal");
    expect(classifyRunCode({ code: "x", allow_network: false })).toBe("write_internal");
  });

  it("reclassifies to write_external when network is requested", () => {
    expect(classifyRunCode({ code: "x", allow_network: true })).toBe("write_external");
  });

  it("effectiveKind honours the tool's classify override", () => {
    expect(effectiveKind(runCodeTool, { code: "x" })).toBe("write_internal");
    expect(effectiveKind(runCodeTool, { code: "x", allow_network: true })).toBe("write_external");
  });

  it("advertises a code parameter and marks it required", () => {
    expect((RUN_CODE_PARAMETERS.required as string[])).toContain("code");
    expect((RUN_CODE_PARAMETERS.properties as Record<string, unknown>).allow_network).toBeDefined();
  });

  it("its label does not trip the destructive backstop for a normal run", () => {
    expect(DESTRUCTIVE_LABEL.test(runCodeTool.label({ code: "x" }))).toBe(false);
  });
});
