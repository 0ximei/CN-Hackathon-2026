import { zipSync } from 'fflate/browser';
import { describe, expect, it } from 'vitest';

import { extractDocument } from './extract';

const enc = new TextEncoder();
const u8 = (s: string) => enc.encode(s);

/** Bytes with no text in them: a PNG's signature and first chunk. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe('extractDocument', () => {
    describe('deciding what a file is', () => {
        /**
         * The extension is a claim by whoever last renamed the file; the magic
         * number is a statement by whatever wrote it. Mail attachments and
         * download folders are full of the first kind being wrong.
         */
        it('goes by the bytes, not the name', () => {
            const docx = zipSync({
                'word/document.xml': u8('<w:document xmlns:w="x"><w:p><w:r><w:t>Boil it.</w:t></w:r></w:p></w:document>'),
            });
            expect(extractDocument(docx, 'report.pdf').format).toBe('docx');
        });

        it('marks a .md file as markdown and a .txt as text', () => {
            expect(extractDocument(u8('# Water\n\nBoil it.'), 'notes.md').format).toBe('markdown');
            expect(extractDocument(u8('Boil it.'), 'notes.txt').format).toBe('text');
        });

        it('names the format it found when it cannot read one', () => {
            expect(() => extractDocument(PNG, 'photo.png')).toThrow(/PNG image/);
        });

        it('names a .doc as the pre-2007 format rather than as noise', () => {
            const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
            expect(() => extractDocument(ole, 'old.doc')).toThrow(/pre-2007/);
        });

        it('refuses an empty file', () => {
            expect(() => extractDocument(new Uint8Array(0), 'nothing.txt')).toThrow(/empty/);
        });

        it('refuses a document with nothing in it to read', () => {
            expect(() => extractDocument(u8('   \n  \n'), 'blank.txt')).toThrow(/no text/);
        });
    });

    describe('plain text', () => {
        it('strips a UTF-8 byte-order mark', () => {
            const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...u8('Boil it.')]);
            expect(extractDocument(bom, 'notes.txt').text).toBe('Boil it.');
        });

        it('reads UTF-16, which is what a Windows editor may hand over', () => {
            const text = 'Boil the water.';
            const le = new Uint8Array(2 + text.length * 2);
            le[0] = 0xff;
            le[1] = 0xfe;
            [...text].forEach((ch, i) => {
                le[2 + i * 2] = ch.charCodeAt(0) & 0xff;
                le[3 + i * 2] = ch.charCodeAt(0) >> 8;
            });
            expect(extractDocument(le, 'notes.txt').text).toBe(text);
        });

        it('keeps a document whose bytes are simply not English', () => {
            const text = '沸騰させてから飲んでください。';
            expect(extractDocument(u8(text), 'notes.txt').text).toBe(text);
        });

        it('refuses bytes that decoded into wreckage', () => {
            // No magic number, so it reaches the text path — where the share of
            // replacement characters is what gives it away.
            const noise = new Uint8Array(400);
            for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256;
            expect(() => extractDocument(noise, 'mystery.txt')).toThrow(/not readable as text/);
        });
    });

    describe('html', () => {
        const PAGE = `<!doctype html><html><head><title>Water Notes</title>
            <style>body { color: red }</style><script>alert('x')</script></head>
            <body><h1>Water</h1><p>Boil it for one minute.</p>
            <ul><li>Above 2000&nbsp;m, boil longer</li></ul>
            <p>Salt &amp; iodine both work.</p></body></html>`;

        it('keeps the readable text and drops the machinery', () => {
            const out = extractDocument(u8(PAGE), 'saved.html');
            expect(out.format).toBe('html');
            expect(out.text).toContain('Boil it for one minute.');
            expect(out.text).toContain('Salt & iodine both work.');
            expect(out.text).not.toContain('color: red');
            expect(out.text).not.toContain('alert');
        });

        it('turns headings into sections', () => {
            expect(extractDocument(u8(PAGE), 'saved.html').text).toContain('## Water');
        });

        it('takes the page title', () => {
            expect(extractDocument(u8(PAGE), 'saved.html').title).toBe('Water Notes');
        });

        it('recognises a page saved without an .html name', () => {
            expect(extractDocument(u8(PAGE), 'download').format).toBe('html');
        });
    });

    describe('rtf', () => {
        it('reads paragraphs and drops the control words', () => {
            const rtf =
                '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}\\f0\\fs24 Boil the water.\\par Then let it cool.\\par}';
            const out = extractDocument(u8(rtf), 'notes.rtf');
            expect(out.format).toBe('rtf');
            expect(out.text).toBe('Boil the water.\nThen let it cool.');
        });

        it('leaves the font and colour tables out of the text', () => {
            const rtf =
                '{\\rtf1{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier;}}{\\colortbl;\\red255\\green0\\blue0;}Boil it.\\par}';
            expect(extractDocument(u8(rtf), 'notes.rtf').text).toBe('Boil it.');
        });

        it('skips a destination it is told it may not understand', () => {
            const rtf = '{\\rtf1{\\*\\generator Riched20 10.0;}Boil it.\\par}';
            expect(extractDocument(u8(rtf), 'notes.rtf').text).toBe('Boil it.');
        });

        it('decodes escaped bytes and Unicode escapes', () => {
            // `\'92` is a curly apostrophe in the Windows code page, and `\u233`
            // is an e-acute with `?` as the fallback a 1990s reader would show.
            const rtf = "{\\rtf1 Don\\'92t boil the caf\\u233?.\\par}";
            expect(extractDocument(u8(rtf), 'notes.rtf').text).toBe('Don’t boil the café.');
        });

        it('reads escaped braces as text', () => {
            const rtf = '{\\rtf1 Use \\{one\\} tablet per litre.\\par}';
            expect(extractDocument(u8(rtf), 'notes.rtf').text).toBe('Use {one} tablet per litre.');
        });
    });
});
