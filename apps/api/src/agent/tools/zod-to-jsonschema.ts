// Minimal Zod -> JSON Schema converter for the generator tool auto-wrapper.
//
// Only covers the shapes the generators actually use: object, string,
// number (int), boolean, enum, literal, array, plus the optional/default/
// nullable/effects wrappers. Anything unrecognised degrades to `{}` (an
// "any" schema) rather than throwing — a generator's exotic field just
// becomes unconstrained in the tool signature.
//
// The output is a raw JSON Schema object suitable for
// `tools[].function.parameters` in the OpenAI/OpenRouter tool spec.
import type { z } from "zod";

type JsonSchema = Record<string, unknown>;

interface AnyDef {
  typeName?: string;
  innerType?: unknown;
  schema?: unknown; // ZodEffects
  type?: unknown; // ZodArray element
  values?: unknown; // ZodEnum
  value?: unknown; // ZodLiteral
  checks?: Array<{ kind?: string }>;
  description?: string;
  shape?: () => Record<string, unknown>;
}

function defOf(schema: unknown): AnyDef {
  return ((schema as { _def?: AnyDef })?._def ?? {}) as AnyDef;
}

interface Unwrapped {
  inner: unknown;
  optional: boolean;
  nullable: boolean;
  description?: string;
}

/** Peel optional/default/nullable/effects wrappers off a schema. */
function unwrap(schema: unknown): Unwrapped {
  let inner = schema;
  let optional = false;
  let nullable = false;
  let description: string | undefined;
  // Bound the loop; wrappers never nest more than a handful deep.
  for (let i = 0; i < 12; i++) {
    const def = defOf(inner);
    if (def.description && !description) description = def.description;
    switch (def.typeName) {
      case "ZodOptional":
        optional = true;
        inner = def.innerType;
        continue;
      case "ZodDefault":
        optional = true;
        inner = def.innerType;
        continue;
      case "ZodNullable":
        nullable = true;
        inner = def.innerType;
        continue;
      case "ZodEffects":
        inner = def.schema;
        continue;
      default:
        return { inner, optional, nullable, description };
    }
  }
  return { inner, optional, nullable, description };
}

function withNull(schema: JsonSchema, nullable: boolean): JsonSchema {
  if (!nullable) return schema;
  const t = schema.type;
  if (typeof t === "string") return { ...schema, type: [t, "null"] };
  return schema; // no concrete type to widen (e.g. enum) — leave as-is
}

/** Convert one Zod field to its JSON Schema fragment. */
function convertField(schema: unknown): JsonSchema {
  const { inner, nullable, description } = unwrap(schema);
  const def = defOf(inner);
  let out: JsonSchema;

  switch (def.typeName) {
    case "ZodString":
      out = { type: "string" };
      break;
    case "ZodNumber":
      out = { type: (def.checks ?? []).some((c) => c.kind === "int") ? "integer" : "number" };
      break;
    case "ZodBoolean":
      out = { type: "boolean" };
      break;
    case "ZodEnum":
      out = { type: "string", enum: [...((def.values as unknown[]) ?? [])] };
      break;
    case "ZodLiteral": {
      const v = def.value;
      const t = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
      out = { type: t, enum: [v] };
      break;
    }
    case "ZodArray":
      out = { type: "array", items: convertField(def.type) };
      break;
    case "ZodObject":
      out = convertObject(inner);
      break;
    default:
      out = {}; // unknown -> "any"
  }

  out = withNull(out, nullable);
  if (description) out.description = description;
  return out;
}

/** Convert a ZodObject (or the inner object of a ZodEffects) to a schema. */
function convertObject(schema: unknown): JsonSchema {
  const def = defOf(schema);
  const shape =
    typeof def.shape === "function"
      ? def.shape()
      : ((schema as { shape?: Record<string, unknown> }).shape ?? {});
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = convertField(field);
    const { optional } = unwrap(field);
    if (!optional) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}

/**
 * Convert a generator's Zod input schema into a JSON Schema `parameters`
 * object. Unwraps a top-level ZodEffects (.refine) to reach the object.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { inner } = unwrap(schema);
  const def = defOf(inner);
  if (def.typeName === "ZodObject") return convertObject(inner);
  // Non-object top level is unexpected for a generator; wrap defensively.
  return { type: "object", properties: {}, additionalProperties: true };
}
