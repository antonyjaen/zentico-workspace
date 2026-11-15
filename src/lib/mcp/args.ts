// Argument validation for MCP tool calls (inputs come from an LLM: validate everything).

/** An error whose message is shown to the MCP client as the tool result. */
export class ToolError extends Error {}

export type Args = Record<string, unknown>;

export function str(a: Args, key: string, opts: { required: true; max?: number }): string;
export function str(a: Args, key: string, opts?: { required?: false; max?: number }): string | undefined;
export function str(a: Args, key: string, { required = false, max = 1000 }: { required?: boolean; max?: number } = {}) {
  const v = a[key];
  if (v == null || v === "") {
    if (required) throw new ToolError(`Missing required argument "${key}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  if (v.length > max) throw new ToolError(`"${key}" is too long (max ${max} characters)`);
  return v;
}

export function int(a: Args, key: string, { min, max, def }: { min: number; max: number; def: number }): number {
  const v = a[key];
  if (v == null || v === "") return def;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ToolError(`"${key}" must be an integer`);
  if (n < min || n > max) throw new ToolError(`"${key}" must be between ${min} and ${max}`);
  return n;
}

export function bool(a: Args, key: string, def = false): boolean {
  const v = a[key];
  if (v == null) return def;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw new ToolError(`"${key}" must be a boolean`);
}

export function strList(a: Args, key: string, { max = 100, itemMax = 320 }: { max?: number; itemMax?: number } = {}): string[] {
  let v = a[key];
  if (v == null || v === "") return [];
  // Be lenient with a single string or a comma-separated list.
  if (typeof v === "string") v = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(v)) throw new ToolError(`"${key}" must be an array of strings`);
  if (v.length > max) throw new ToolError(`"${key}" has too many items (max ${max})`);
  return v.map((x) => {
    if (typeof x !== "string" || !x.trim() || x.length > itemMax) throw new ToolError(`"${key}" must contain non-empty strings`);
    return x.trim();
  });
}

export function oneOf<T extends string>(a: Args, key: string, values: readonly T[], def: T): T {
  const v = a[key];
  if (v == null || v === "") return def;
  if (typeof v !== "string" || !values.includes(v as T)) throw new ToolError(`"${key}" must be one of: ${values.join(", ")}`);
  return v as T;
}

const ID = /^[A-Za-z0-9_-]{1,255}$/;

export function id(a: Args, key: string, opts: { required: true }): string;
export function id(a: Args, key: string, opts?: { required?: false }): string | undefined;
export function id(a: Args, key: string, { required = false }: { required?: boolean } = {}) {
  const v = str(a, key, { required: required as false, max: 255 });
  if (v === undefined) return undefined;
  if (!ID.test(v)) throw new ToolError(`"${key}" is not a valid id`);
  return v;
}

export function idList(a: Args, key: string, max = 200): string[] {
  const list = strList(a, key, { max, itemMax: 255 });
  for (const v of list) if (!ID.test(v)) throw new ToolError(`"${key}" contains an invalid id`);
  return list;
}

const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

/** Accepts "a@b.c" or "Name <a@b.c>" and returns the bare address. */
export function emailList(a: Args, key: string, max = 100): string[] {
  return strList(a, key, { max }).map((s) => {
    const m = /<([^<>]+)>\s*$/.exec(s);
    const email = (m ? m[1] : s).trim();
    if (!isEmail(email)) throw new ToolError(`"${key}" contains an invalid email address: ${s}`);
    return email;
  });
}

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
