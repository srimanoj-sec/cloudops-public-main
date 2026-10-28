import { describe, expect, it } from 'vitest';
import { csvCell } from './inventory.service.js';

describe('csvCell', () => {
  it('passes plain values through', () => {
    expect(csvCell('vm-prod-01')).toBe('vm-prod-01');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes values containing separators, quotes or newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection from provider-controlled values', () => {
    for (const hostile of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1']) {
      const cell = csvCell(hostile).replace(/^"|"$/g, '');
      expect(cell.startsWith("'")).toBe(true);
    }
  });
});
