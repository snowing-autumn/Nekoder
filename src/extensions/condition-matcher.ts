export type Condition =
  | { readonly field: string; readonly equals: string | number | boolean; readonly ignore_case?: boolean }
  | { readonly field: string; readonly glob: string; readonly ignore_case?: boolean }
  | { readonly field: string; readonly regex: string; readonly ignore_case?: boolean }
  | { readonly not: Condition }
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] };

export interface CompileConditionOptions {
  readonly allowedFields?: readonly string[];
  readonly maxRegexBytes?: number;
}

export class ConditionCompileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConditionCompileError";
  }
}

export type CompiledCondition = (value: unknown) => boolean;

export function compileCondition(condition: Condition, options: CompileConditionOptions = {}): CompiledCondition {
  const allowedFields = options.allowedFields ? new Set(options.allowedFields) : undefined;
  return compileNode(condition, allowedFields, options.maxRegexBytes ?? 1024);
}

function compileNode(condition: Condition, allowedFields: ReadonlySet<string> | undefined, maxRegexBytes: number): CompiledCondition {
  if (!isRecord(condition)) throw invalid("condition_invalid", "Condition must be an object");
  const keys = Object.keys(condition).filter((key) => key !== "ignore_case");
  if ("not" in condition) {
    if (keys.length !== 1) throw invalid("condition_ambiguous", "not cannot be combined with another condition");
    const child = compileNode(condition.not, allowedFields, maxRegexBytes);
    return (value) => !child(value);
  }
  if ("all" in condition || "any" in condition) {
    if (keys.length !== 1) throw invalid("condition_ambiguous", "all/any cannot be combined with another condition");
    const mode = "all" in condition ? "all" : "any";
    const nodes = "all" in condition ? condition.all : condition.any;
    if (!Array.isArray(nodes) || nodes.length === 0) throw invalid("condition_empty", `${mode} requires at least one child`);
    const children = nodes.map((node) => compileNode(node, allowedFields, maxRegexBytes));
    return mode === "all"
      ? (value) => children.every((child) => child(value))
      : (value) => children.some((child) => child(value));
  }
  if (!("field" in condition) || typeof condition.field !== "string" || !condition.field) {
    throw invalid("condition_field_invalid", "Leaf condition requires a field");
  }
  if (allowedFields && !allowedFields.has(condition.field)) throw invalid("condition_field_unknown", `Field is not matchable: ${condition.field}`);
  const operators = ["equals", "glob", "regex"].filter((operator) => operator in condition);
  if (operators.length !== 1 || keys.some((key) => !["field", ...operators].includes(key))) {
    throw invalid("condition_ambiguous", "Leaf condition requires exactly one operator");
  }
  const ignoreCase = condition.ignore_case === true;
  if ("equals" in condition) {
    const expected = condition.equals;
    return (value) => {
      const actual = fieldValue(value, condition.field);
      return ignoreCase && typeof actual === "string" && typeof expected === "string"
        ? actual.toLocaleLowerCase() === expected.toLocaleLowerCase()
        : actual === expected;
    };
  }
  if ("glob" in condition) {
    if (typeof condition.glob !== "string") throw invalid("condition_glob_invalid", "glob must be a string");
    const regex = compileGlob(condition.glob, ignoreCase);
    return (value) => {
      const actual = fieldValue(value, condition.field);
      return typeof actual === "string" && regex.test(actual.replaceAll("\\", "/"));
    };
  }
  if (typeof condition.regex !== "string") throw invalid("condition_regex_invalid", "regex must be a string");
  const regex = compileSafeRegex(condition.regex, ignoreCase, maxRegexBytes);
  return (value) => {
    const actual = fieldValue(value, condition.field);
    return typeof actual === "string" && regex.test(actual);
  };
}

function compileSafeRegex(source: string, ignoreCase: boolean, maxBytes: number): RegExp {
  if (Buffer.byteLength(source, "utf8") > maxBytes) throw invalid("condition_regex_too_large", `regex exceeds ${maxBytes} bytes`);
  if (/\\[1-9]|\\k[<{]|\(\?(?:[=!]|<[=!])/u.test(source)) {
    throw invalid("condition_regex_not_re2", "regex uses look-around or a backreference, which RE2 does not support");
  }
  if (/\(\?>|\(\?\(|\(\?[ims-]+:/u.test(source)) throw invalid("condition_regex_not_re2", "regex uses a construct that RE2 does not support");
  // Reject the common nested-repeat family before passing the expression to the JS engine.
  if (/\([^)]*(?:[*+?]|\||\{\d+(?:,\d*)?\})[^)]*\)(?:[*+?]|\{\d+(?:,\d*)?\})/u.test(source)) {
    throw invalid("condition_regex_not_linear", "regex contains nested repetition");
  }
  try { return new RegExp(source, ignoreCase ? "iu" : "u"); }
  catch (error) { throw invalid("condition_regex_invalid", `Invalid regex: ${String(error)}`); }
}

function compileGlob(pattern: string, ignoreCase: boolean): RegExp {
  const source = pattern.replaceAll("\\", "/")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${source}$`, ignoreCase ? "iu" : "u");
}

function fieldValue(value: unknown, field: string): unknown {
  let current: unknown = value;
  for (const segment of field.split(".")) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function invalid(code: string, message: string): ConditionCompileError {
  return new ConditionCompileError(code, message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
