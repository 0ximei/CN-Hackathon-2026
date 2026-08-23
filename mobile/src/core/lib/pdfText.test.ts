import { zlibSync } from 'fflate/browser';
import { describe, expect, it } from 'vitest';

import { extractPdfText } from './pdfText';

/**
 * PDFs are built here rather than checked in as fixtures.
 *
 * A binary blob in the repository is a test nobody can read and nobody can
 * adjust: the interesting part of each case below is one field — a
 * `/FontMatrix`, a `ToUnicode` that maps nothing, a positioning operator per
 * glyph — and a fixture hides exactly that field. Written out, each test says
 * which shape of file it stands for.
 */

const enc = new TextEncoder();

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
    const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

/** A stream object, with the length the reader is meant to trust. */
function stream(dict: string, data: Uint8Array | string): Uint8Array {
    const body = typeof data === 'string' ? enc.encode(data) : data;
    return bytes(`<< ${dict} /Length ${body.length} >>\nstream\n`, body, '\nendstream');
}

/**
 * Assembles numbered objects into a file.
 *
 * No cross-reference table: the reader rebuilds one by scanning, which is the
 * path every real file with a stale xref takes anyway, so the tests exercise it
 * rather than a table they would have to keep correct by hand.
 */
function buildPdf(objects: (string | Uint8Array)[], trailer: string): Uint8Array {
    const parts: (string | Uint8Array)[] = ['%PDF-1.7\n'];
    objects.forEach((obj, i) => {
        parts.push(`${i + 1} 0 obj\n`, obj, '\nendobj\n');
    });
    parts.push(`trailer\n<< ${trailer} >>\n%%EOF\n`);
    return bytes(...parts);
}

/** Every code the same half-em wide, so advances are predictable in a test. */
const HALF_EM_WIDTHS = `/FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(500).join(' ')}]`;

/**
 * Long enough to clear the "is there a document here at all" floor, and
 * deliberately unspaced: any space in the output of a test using this came from
 * the reader, which is the thing under test.
 */
const RUN_ON = 'Boilthewaterbeforedrinkingit';

/** Draws `text` one glyph at a time, each placed exactly where the last ended. */
function perGlyph(text: string, advance: number, size = 12): string {
    let out = `BT /F1 ${size} Tf 72 700 Td `;
    for (const ch of text) out += `(${ch}) Tj ${advance} 0 Td `;
    return `${out}ET`;
}

function onePage(content: string | Uint8Array, fontObj: string, extraTrailer = ''): Uint8Array {
    return buildPdf(
        [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            fontObj,
            stream('', content),
        ],
        `/Root 1 0 R ${extraTrailer}`,
    );
}

const SIMPLE_FONT = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${HALF_EM_WIDTHS} >>`;

describe('extractPdfText', () => {
    it('reads a string a page draws', () => {
        const pdf = onePage('BT /F1 12 Tf 72 700 Td (Boil the water for one minute) Tj ET', SIMPLE_FONT);
        expect(extractPdfText(pdf).text).toBe('Boil the water for one minute');
    });

    it('reads a Flate-compressed content stream', () => {
        const content = zlibSync(enc.encode('BT /F1 12 Tf 72 700 Td (Boil the water for one minute) Tj ET'));
        const pdf = buildPdf(
            [
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                SIMPLE_FONT,
                stream('/Filter /FlateDecode', content),
            ],
            '/Root 1 0 R',
        );
        expect(extractPdfText(pdf).text).toContain('Boil the water');
    });

    /**
     * The case that matters most, because it is silent when it goes wrong.
     *
     * Nothing in this content stream contains a space character. The words are
     * separated only by where the pen was put, so a reader that does not track
     * advances either runs them together or — if it emits a space per move —
     * puts one between every letter.
     */
    describe('spaces the producer never wrote', () => {
        it('finds the gap between two positioned words', () => {
            // "Boilthewater" at 12pt is 12 x 6 = 72 wide, so the pen rests at
            // 144; the next word starts at 272, a gap far wider than a space.
            const pdf = onePage(
                'BT /F1 12 Tf 72 700 Td (Boilthewater) Tj 200 0 Td (beforedrinkingit) Tj ET',
                SIMPLE_FONT,
            );
            expect(extractPdfText(pdf).text).toBe('Boilthewater beforedrinkingit');
        });

        it('does not space out glyphs positioned one at a time', () => {
            // Half an em at 12pt is 6 units, and every glyph is placed exactly
            // that far along: there is no gap anywhere to read as a space.
            const pdf = onePage(perGlyph(RUN_ON, 6), SIMPLE_FONT);
            expect(extractPdfText(pdf).text).toBe(RUN_ON);
        });

        it('reads Type 3 widths through the font matrix', () => {
            // Chrome's print-to-PDF writes Type 3 fonts whose widths are in
            // glyph space. 50 x 0.02 = 1.0 em, so at 12pt each glyph advances
            // 12 units — and the positions below match that exactly. Read raw,
            // 50 would look like a twentieth of an em and every glyph would
            // seem to be followed by a gap.
            const type3 = `<< /Type /Font /Subtype /Type3 /FontMatrix [0.02 0 0 0.02 0 0] /FontBBox [0 0 50 50] /CharProcs << >> /Encoding << >> /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(50).join(' ')}] >>`;
            const pdf = onePage(perGlyph(RUN_ON, 12), type3);
            expect(extractPdfText(pdf).text).toBe(RUN_ON);
        });

        it('reads a wide kern inside a TJ array as a space', () => {
            const pdf = onePage(
                'BT /F1 12 Tf 72 700 Td [(Boilthewater) -400 (beforedrinkingit)] TJ ET',
                SIMPLE_FONT,
            );
            expect(extractPdfText(pdf).text).toBe('Boilthewater beforedrinkingit');
        });

        it('leaves tight pair kerning alone', () => {
            const pdf = onePage(
                'BT /F1 12 Tf 72 700 Td [(Boilthewater) -20 (beforedrinkingit)] TJ ET',
                SIMPLE_FONT,
            );
            expect(extractPdfText(pdf).text).toBe('Boilthewaterbeforedrinkingit');
        });
    });

    it('breaks a line where the page moved down', () => {
        const pdf = onePage(
            'BT /F1 12 Tf 72 700 Td (Boil the water) Tj 0 -14 Td (Then let it cool) Tj ET',
            SIMPLE_FONT,
        );
        expect(extractPdfText(pdf).text).toBe('Boil the water\nThen let it cool');
    });

    /**
     * A two-byte font whose `ToUnicode` map says its codes are one byte wide.
     *
     * Producers write these, and reading the string a byte at a time returns a
     * perfectly plausible-looking string of entirely the wrong characters —
     * which then gets signed, replicated and searched, with nothing downstream
     * able to tell. The font's own composite-ness has to win.
     */
    it('reads a composite font two bytes at a time whatever its map implies', () => {
        // Source codes written two hex digits wide — implying one byte — while
        // the strings below are Identity-H, so genuinely two.
        const glyphs = [...RUN_ON];
        const toUnicode = `/CIDInit /ProcSet findresource begin
begincmap
1 begincodespacerange <00> <FF> endcodespacerange
${glyphs.length} beginbfchar
${glyphs
    .map((ch, i) => `<${(i + 1).toString(16).padStart(2, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`)
    .join('\n')}
endbfchar
endcmap`;
        const shown = glyphs.map((_, i) => (i + 1).toString(16).padStart(4, '0')).join('');
        const pdf = buildPdf(
            [
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAB+Sub /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
                stream('', `BT /F1 12 Tf 72 700 Td <${shown}> Tj ET`),
                '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAB+Sub /DW 600 >>',
                stream('', toUnicode),
            ],
            '/Root 1 0 R',
        );
        expect(extractPdfText(pdf).text).toBe(RUN_ON);
    });

    describe('refusing rather than guessing', () => {
        it('names a page with no text as a probable scan', () => {
            const pdf = onePage('72 700 200 100 re f', SIMPLE_FONT);
            expect(() => extractPdfText(pdf)).toThrow(/no text layer|probably a scan/);
        });

        it('distinguishes an unmappable font from a scan', () => {
            // A `ToUnicode` that declares a codespace and then maps nothing —
            // shipped by real producers, and the same as having none at all.
            const emptyMap = `begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
endcmap`;
            const pdf = buildPdf(
                [
                    '<< /Type /Catalog /Pages 2 0 R >>',
                    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                    '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAB+Sub /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
                    stream('', 'BT /F1 12 Tf 72 700 Td <0062003600370038> Tj ET'),
                    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAB+Sub /DW 600 >>',
                    stream('', emptyMap),
                ],
                '/Root 1 0 R',
            );
            expect(() => extractPdfText(pdf)).toThrow(/glyph shapes|character map/);
        });

        it('says so when the file is encrypted', () => {
            const pdf = onePage('BT /F1 12 Tf 72 700 Td (Boil the water) Tj ET', SIMPLE_FONT, '/Encrypt 9 0 R');
            expect(() => extractPdfText(pdf)).toThrow(/password-protected/);
        });
    });

    it('keeps the pages in the order the page tree gives them', () => {
        // Kids listed against object order on purpose: object number is
        // assignment order, which is not reading order.
        const pdf = buildPdf(
            [
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [4 0 R 3 0 R] /Count 2 >>',
                '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
                '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
                SIMPLE_FONT,
                stream('', 'BT /F1 12 Tf 72 700 Td (First page here) Tj ET'),
                stream('', 'BT /F1 12 Tf 72 700 Td (Second page here) Tj ET'),
            ],
            '/Root 1 0 R',
        );
        expect(extractPdfText(pdf).text).toBe('First page here\n\nSecond page here');
    });

    it('inherits resources from a parent page node', () => {
        const pdf = buildPdf(
            [
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>',
                '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
                SIMPLE_FONT,
                stream('', 'BT /F1 12 Tf 72 700 Td (Boil the water before drinking it) Tj ET'),
            ],
            '/Root 1 0 R',
        );
        expect(extractPdfText(pdf).text).toBe('Boil the water before drinking it');
    });

    it('takes a title from the document information dictionary', () => {
        const pdf = buildPdf(
            [
                '<< /Type /Catalog /Pages 2 0 R >>',
                '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                SIMPLE_FONT,
                stream('', 'BT /F1 12 Tf 72 700 Td (Boil the water for one minute) Tj ET'),
                '<< /Title (Field Water Treatment) /Producer (a test) >>',
            ],
            '/Root 1 0 R /Info 6 0 R',
        );
        expect(extractPdfText(pdf).title).toBe('Field Water Treatment');
    });

    it('rejoins a sentence the page broke across two lines', () => {
        const pdf = onePage(
            'BT /F1 12 Tf 72 700 Td (Boil the water for) Tj 0 -14 Td (one full minute) Tj ET',
            SIMPLE_FONT,
        );
        expect(extractPdfText(pdf).text).toBe('Boil the water for one full minute');
    });

    it('steps over an inline image without reading its bytes as operators', () => {
        // The image data holds an unbalanced `(`, which a tokeniser that does
        // not skip the block will read as the start of a string and swallow
        // the rest of the page into.
        const pdf = onePage(
            'BT /F1 12 Tf 72 700 Td (Before) Tj ET\nBI /W 4 /H 4 /BPC 8 /CS /G ID (((( EI\nBT /F1 12 Tf 72 680 Td (After the picture) Tj ET',
            SIMPLE_FONT,
        );
        expect(extractPdfText(pdf).text).toContain('After the picture');
    });
});
