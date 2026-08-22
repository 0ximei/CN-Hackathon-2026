import { describe, expect, it } from 'vitest';
import { normalizeUploadedText } from './textUpload';

describe('normalizeUploadedText', () => {
  it('removes BOM and trims text before indexing', () => {
    const value = '\uFEFF  hello world\n\n';
    expect(normalizeUploadedText(value)).toBe('hello world');
  });

  it('preserves useful content but collapses empty uploads', () => {
    expect(normalizeUploadedText('   \n\t  ')).toBe('');
    expect(normalizeUploadedText('first line\nsecond line')).toBe('first line\nsecond line');
  });
});
