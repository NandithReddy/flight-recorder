/**
 * Redaction, applied on the way IN.
 *
 * A span's input and output pass through here before the recorder holds them,
 * so a secret never reaches the trace object, let alone disk. Redacting on read
 * would leave the secret in every blob forever.
 *
 * Two mechanisms, because either alone leaks:
 *   - Value patterns catch secrets embedded in free text ("use key sk-ant-...").
 *   - Key names catch secrets that look like nothing in particular
 *     ({"password": "hunter2"} matches no pattern worth writing).
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Replacement; `$1` etc. from the pattern are available. */
  replacement: string;
}

export const REDACTED = "[redacted]";

/**
 * Order matters: specific provider formats run before the generic bearer and
 * long-digit rules, so an Anthropic key is labelled as one rather than being
 * swallowed by a broader pattern.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    replacement: "[redacted:anthropic-key]",
  },
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g,
    replacement: "[redacted:openai-key]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    replacement: "[redacted:github-token]",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[redacted:aws-key]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "[redacted:jwt]",
  },
  {
    name: "bearer",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: "$1[redacted]",
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[redacted:email]",
  },
];

/** Object keys whose value is replaced wholesale, regardless of its shape. */
export const DEFAULT_SENSITIVE_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "sessionid",
  "session_id",
  "cookie",
];

export interface RedactorOptions {
  rules?: RedactionRule[];
  sensitiveKeys?: string[];
  /**
   * Redact card-like digit runs that pass a Luhn check. Off by default: the
   * check is cheap but the false-positive cost on numeric agent output (order
   * ids, metrics) is real, so it is opt-in per deployment.
   */
  redactLuhn?: boolean;
}

export type Redactor = (value: unknown) => unknown;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCardNumbers(text: string): string {
  return text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[^0-9]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? "[redacted:card]" : match;
  });
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const rules = options.rules ?? DEFAULT_RULES;
  const sensitiveKeys = new Set(
    (options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS).map((k) => k.toLowerCase()),
  );
  const redactLuhn = options.redactLuhn ?? false;

  const scrubString = (text: string): string => {
    let out = text;
    for (const rule of rules) {
      // Patterns are module-level and carry /g, so lastIndex must be reset
      // before each use or every other call silently starts mid-string.
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
    }
    return redactLuhn ? redactCardNumbers(out) : out;
  };

  const isSensitiveKey = (key: string): boolean =>
    sensitiveKeys.has(key.toLowerCase().replace(/[^a-z_]/g, ""));

  const walk = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return scrubString(value);
    if (value === null || typeof value !== "object") return value;

    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => walk(item, seen));

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(item, seen);
    }
    return out;
  };

  return (value: unknown) => walk(value, new WeakSet<object>());
}

/** The redactor used when a Recorder is constructed without one. */
export const defaultRedactor: Redactor = createRedactor();
