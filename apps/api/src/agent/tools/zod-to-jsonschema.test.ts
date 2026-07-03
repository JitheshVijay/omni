import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-jsonschema.js";

describe("zodToJsonSchema", () => {
  it("converts a basic object with strings and required tracking", () => {
    const schema = z.object({
      prompt: z.string(),
      title: z.string().optional(),
    });
    const js = zodToJsonSchema(schema);
    expect(js.type).toBe("object");
    expect((js.properties as Record<string, unknown>).prompt).toEqual({ type: "string" });
    expect((js.properties as Record<string, unknown>).title).toEqual({ type: "string" });
    expect(js.required).toEqual(["prompt"]);
    expect(js.additionalProperties).toBe(false);
  });

  it("maps int-constrained numbers to integer and plain numbers to number", () => {
    const schema = z.object({
      count: z.number().int().min(1).max(20).default(8),
      ratio: z.number(),
    });
    const props = zodToJsonSchema(schema).properties as Record<string, { type: string }>;
    expect(props.count.type).toBe("integer");
    expect(props.ratio.type).toBe("number");
  });

  it("treats default() and optional() as not-required", () => {
    const schema = z.object({
      a: z.string(),
      b: z.string().default("x"),
      c: z.boolean().optional(),
    });
    const js = zodToJsonSchema(schema);
    expect(js.required).toEqual(["a"]);
    expect((js.properties as Record<string, { type: string }>).c.type).toBe("boolean");
  });

  it("emits enums as string + enum values", () => {
    const schema = z.object({ theme: z.enum(["midnight", "daylight"]) });
    const theme = (zodToJsonSchema(schema).properties as Record<string, unknown>).theme;
    expect(theme).toEqual({ type: "string", enum: ["midnight", "daylight"] });
  });

  it("handles nullable+optional (hub_id shape) as a skippable field", () => {
    const schema = z.object({ hub_id: z.string().nullable().optional() });
    const js = zodToJsonSchema(schema);
    expect(js.required).toBeUndefined();
    // nullable widens the type to include null
    const hub = (js.properties as Record<string, { type: unknown }>).hub_id;
    expect(hub.type).toEqual(["string", "null"]);
  });

  it("unwraps a top-level ZodEffects (.refine) to reach the object", () => {
    const schema = z
      .object({ text: z.string().optional(), artifact_id: z.string().optional() })
      .refine((d) => Boolean(d.text) !== Boolean(d.artifact_id), { message: "one of" });
    const js = zodToJsonSchema(schema);
    expect(js.type).toBe("object");
    expect(Object.keys(js.properties as object).sort()).toEqual(["artifact_id", "text"]);
  });

  it("converts arrays of a primitive", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const tags = (zodToJsonSchema(schema).properties as Record<string, unknown>).tags;
    expect(tags).toEqual({ type: "array", items: { type: "string" } });
  });
});
