import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnv } from './env';

describe('parseEnv', () => {
  it('parses keys, comments, quotes, export and inline comments', () => {
    const out = parseEnv([
      '# comment', '', 'DEEPGRAM_API_KEY=abc123', 'PORT=8787 # inline', 'QUOTED="hello world"', "SINGLE='a#b'",
      'export EXPORTED=yes', 'EMPTY=', '  SPACED = value  ', 'not a valid line', '1BAD=x',
    ].join('\n'));
    expect(out).toEqual({
      DEEPGRAM_API_KEY: 'abc123', PORT: '8787', QUOTED: 'hello world', SINGLE: 'a#b', EXPORTED: 'yes', EMPTY: '', SPACED: 'value',
    });
  });
  it('handles CRLF', () => {
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadEnvFile', () => {
  it('loads into the target without overriding existing values; missing file is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envtest-'));
    try {
      const file = join(dir, '.env');
      writeFileSync(file, 'A=from-file\nB=from-file\n');
      const target: Record<string, string | undefined> = { A: 'already' };
      expect(loadEnvFile(file, target)).toEqual(['B']);
      expect(target).toEqual({ A: 'already', B: 'from-file' });
      expect(loadEnvFile(join(dir, 'nope'), target)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
