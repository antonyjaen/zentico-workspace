// Basic JSON-schema shape checks on tool arguments before they are forwarded to a remote MCP
// server: types (incl. unions and nullable), required properties, enum/const, string length,
// number range, array length/items and additionalProperties:false. Not a full validator: it
// catches malformed input from mods and LLMs early; the remote server still validates. Server-only.
import { UserMcpError } from "./errors";

type Schema = Record<string, unknown>;

const MAX_ARGS_BYTES = 64 * 1024;
const MAX_DEPTH = 20;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function matchesType(v: unknown, type: string): boolean {
  const t = typeOf(v);
  if (type === "number") return t === "number" || t === "integer";
  return t === type;
}

function fail(path: string, msg: string): never {
  throw new UserMcpError("invalid_args", `${path || "arguments"} ${msg}`);
}

function check(v: unknown, schema: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) fail(path, "is nested too deeply");
  if (!isObj(schema)) return; // true / {} / unknown forms: anything goes
  const types = Array.isArray(schema.type) ? schema.type.filter((x): x is string => typeof x === "string") : typeof schema.type === "string" ? [schema.type] : [];
  if (schema.nullable === true && v === null) return;
  if (types.length && !types.some((t) => matchesType(v, t))) fail(path, `must be ${types.join(" or ")}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    fail(path, `must be one of: ${schema.enum.slice(0, 20).map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) fail(path, `must be ${JSON.stringify(schema.const)}`);

  if (typeof v === "string") {
    if (typeof schema.maxLength === "number" && v.length > schema.maxLength) fail(path, `is longer than ${schema.maxLength} characters`);
    if (typeof schema.minLength === "number" && v.length < schema.minLength) fail(path, `is shorter than ${schema.minLength} characters`);
  } else if (typeof v === "number") {
    if (!Number.isFinite(v)) fail(path, "must be a finite number");
    if (typeof schema.minimum === "number" && v < schema.minimum) fail(path, `must be ≥ ${schema.minimum}`);
    if (typeof schema.maximum === "number" && v > schema.maximum) fail(path, `must be ≤ ${schema.maximum}`);
  } else if (Array.isArray(v)) {
    if (typeof schema.maxItems === "number" && v.length > schema.maxItems) fail(path, `has more than ${schema.maxItems} items`);
    if (typeof schema.minItems === "number" && v.length < schema.minItems) fail(path, `has fewer than ${schema.minItems} items`);
    if (isObj(schema.items)) v.forEach((x, i) => check(x, schema.items, `${path}[${i}]`, depth + 1));
  } else if (isObj(v)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (typeof k === "string" && v[k] === undefined) fail(path ? `${path}.${k}` : k, "is required");
    }
    for (const [k, x] of Object.entries(v)) {
      const sub = path ? `${path}.${k}` : k;
      if (k in props) check(x, props[k], sub, depth + 1);
      else if (schema.additionalProperties === false) fail(sub, "is not an allowed property");
      else if (isObj(schema.additionalProperties)) check(x, schema.additionalProperties, sub, depth + 1);
    }
  }
}

/** Validates tool arguments against the tool's input schema (shape only). Returns the args object. */
export function validateArgs(args: unknown, inputSchema: Schema | undefined): Record<string, unknown> {
  const value = args === undefined || args === null ? {} : args;
  if (!isObj(value)) throw new UserMcpError("invalid_args", "arguments must be a JSON object");
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new UserMcpError("invalid_args", "arguments must be plain JSON");
  }
  if (size > MAX_ARGS_BYTES) throw new UserMcpError("invalid_args", `arguments are too large (max ${MAX_ARGS_BYTES / 1024} KB)`);
  check(value, inputSchema ?? { type: "object" }, "", 0);
  return value;
}
