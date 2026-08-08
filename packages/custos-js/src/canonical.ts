/**
 * Canonical JSON serialization — MUST match Python `custos.canonical.dumps`
 * byte-for-byte.
 *
 * Rules (spec/WIRE.md §1):
 *   - UTF-8 output (Buffer/Uint8Array on caller side)
 *   - Keys sorted lexicographically at every depth
 *   - No insignificant whitespace
 *   - Do not escape non-ASCII (raw UTF-8)
 *   - Reject NaN / Infinity
 */

export function canonicalStringify(value: unknown): string {
  return _stringify(value);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(_stringify(value));
}

function _stringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical JSON: non-finite number");
    return _num(v);
  }
  if (typeof v === "string") return _str(v);
  if (Array.isArray(v)) return "[" + v.map(_stringify).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      parts[i] = _str(k) + ":" + _stringify(obj[k]);
    }
    return "{" + parts.join(",") + "}";
  }
  if (typeof v === "undefined") throw new Error("canonical JSON: undefined not allowed");
  throw new Error(`canonical JSON: unsupported type ${typeof v}`);
}

// Match Python json output for numbers.
function _num(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(0);
  return JSON.stringify(n); // Python & JS both use shortest-roundtrip for floats
}

// String escaping compatible with Python json.dumps(ensure_ascii=False).
// Python escapes: \b \f \n \r \t \" \\ and control chars < 0x20 as \u00XX.
// Everything >= 0x20 (including non-ASCII) is emitted raw.
function _str(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}
