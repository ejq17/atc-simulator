/**
 * Minimal `.env` loader (no dependency). Supports `KEY=value`, `export KEY=value`,
 * `#` comment lines, blank lines, single/double quoted values and trailing
 * ` # comments` on unquoted values. Existing environment variables win.
 */
import { existsSync, readFileSync } from 'node:fs';

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

/** Load `path` into `target` (default process.env) without overriding existing keys. Returns keys set. */
export function loadEnvFile(path: string, target: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return [];
  const set: string[] = [];
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (target[k] === undefined) { target[k] = v; set.push(k); }
  }
  return set;
}
