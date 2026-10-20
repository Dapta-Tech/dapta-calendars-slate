import { describe, expect, it } from 'vitest';
import { readZip } from '@/lib/test/read-zip';
import { crc32, createZip, dosDateTime } from './zip';

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32 of the ASCII digits 1 to 9 is the published check value.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('createZip', () => {
  it('round-trips nested paths, UTF-8 names and text, and both storage methods', () => {
    const long = 'Repeat me. '.repeat(500);
    const zip = createZip([
      { path: 'SKILL.md', content: long },
      { path: 'reference/errors.md', content: 'Configuración: sí' },
      // A name outside ASCII: the UTF-8 flag and the name bytes must match in both headers.
      { path: 'referencia/guía rápida.md', content: 'ñ' },
      { path: 'a.txt', content: 'x' },
    ]);
    // readZip holds every local header to its directory entry, field by field.
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['SKILL.md', 'reference/errors.md', 'referencia/guía rápida.md', 'a.txt']);
    expect(files.get('SKILL.md')).toBe(long);
    expect(files.get('reference/errors.md')).toBe('Configuración: sí');
    expect(files.get('referencia/guía rápida.md')).toBe('ñ');
    expect(files.get('a.txt')).toBe('x');
    // Deflate actually ran on the repetitive file.
    expect(zip.length).toBeLessThan(long.length);
  });

  it('refuses a path that could escape the folder it is unpacked into, on any system', () => {
    for (const path of ['', '../evil.md', 'a/../../evil.md', '/abs.md', 'a\\..\\evil.md', 'C:/evil.md', 'c:evil.md']) {
      expect(() => createZip([{ path, content: '' }]), path).toThrow();
    }
  });

  it('stamps entries in local time, as unzip tools read the DOS fields', () => {
    const at = new Date(2026, 9, 19, 14, 30, 58); // local 2026-10-19 14:30:58
    expect(dosDateTime(at)).toEqual({
      time: (14 << 11) | (30 << 5) | 29,
      date: ((2026 - 1980) << 9) | (10 << 5) | 19,
    });
    // Nothing before 1980 exists in the format.
    expect(dosDateTime(new Date(1975, 0, 1)).date >> 9).toBe(0);
  });
});
