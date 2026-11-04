// Settings coercion. Stored settings may be hand-edited or from an older version, so every
// field is forced to a valid value. Pure, no I/O.
//
// A schema maps each key to one of:
//   { default: number, range: [min, max] }  finite numbers are clamped, anything else gives the default
//   { default, oneOf: [...] }               values not in the list give the default
//   { default: boolean }                    non-booleans give the default
// Keys not in the schema are dropped.
export function coerceSettings(raw, schema) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const [key, field] of Object.entries(schema)) {
    const v = src[key]
    if (field.range) {
      const [min, max] = field.range
      out[key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : field.default
    } else if (field.oneOf) {
      out[key] = field.oneOf.includes(v) ? v : field.default
    } else {
      out[key] = typeof v === 'boolean' ? v : field.default
    }
  }
  return out
}
