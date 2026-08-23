import { zipSync } from 'fflate/browser';
import { describe, expect, it } from 'vitest';

import { extractOfficeText } from './officeText';

const enc = new TextEncoder();

function zip(files: Record<string, string>): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    for (const [name, body] of Object.entries(files)) entries[name] = enc.encode(body);
    return zipSync(entries);
}

function docx(body: string, core?: string): Uint8Array {
    return zip({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
        ...(core ? { 'docProps/core.xml': core } : {}),
    });
}

/** A run of text, as Word writes one. */
function p(text: string, style?: string): string {
    const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
    return `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

describe('extractOfficeText · docx', () => {
    it('reads paragraphs as lines', () => {
        const out = extractOfficeText(docx(p('Boil the water.') + p('Then let it cool.')));
        expect(out.format).toBe('docx');
        expect(out.text).toBe('Boil the water.\nThen let it cool.');
    });

    /**
     * Headings become sections, never titles.
     *
     * `parseDocument` reads a `# ` line as the document's name and takes the
     * last one, so emitting `# ` here would name a three-heading document after
     * its third heading and drop the other two out of the body entirely.
     */
    it('marks every heading level as a section', () => {
        const out = extractOfficeText(
            docx(p('Water', 'Heading1') + p('Boiling', 'Heading2') + p('Bring to a boil.')),
        );
        expect(out.text).toBe('## Water\n## Boiling\nBring to a boil.');
    });

    it('joins the runs Word splits a sentence into', () => {
        // Word breaks a paragraph at every formatting change and at spell-check
        // boundaries, so a single sentence routinely arrives as five runs.
        const split = '<w:p><w:r><w:t xml:space="preserve">Boil the </w:t></w:r><w:r><w:t>water</w:t></w:r><w:r><w:t xml:space="preserve"> now</w:t></w:r></w:p>';
        expect(extractOfficeText(docx(split)).text).toBe('Boil the water now');
    });

    it('honours breaks and tabs inside a paragraph', () => {
        const body = '<w:p><w:r><w:t>One</w:t><w:br/><w:t>Two</w:t><w:tab/><w:t>Three</w:t></w:r></w:p>';
        expect(extractOfficeText(docx(body)).text).toBe('One\nTwo Three');
    });

    it('leaves field instructions out of the text', () => {
        // `instrText` is the machinery behind a page number or a cross
        // reference — it is a formula, not something anybody wrote.
        const body = `<w:p><w:r><w:t>See page </w:t></w:r><w:r><w:instrText>PAGEREF _Ref12345</w:instrText></w:r><w:r><w:t>4</w:t></w:r></w:p>`;
        expect(extractOfficeText(docx(body)).text).toBe('See page 4');
    });

    it('decodes entities', () => {
        expect(extractOfficeText(docx(p('Salt &amp; water &lt; 5&#37;'))).text).toBe(
            'Salt & water < 5%',
        );
    });

    it('takes the title the file states about itself', () => {
        const core =
            '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:title>Field Water Treatment</dc:title></cp:coreProperties>';
        expect(extractOfficeText(docx(p('Boil it.'), core)).title).toBe('Field Water Treatment');
    });

    it('has no title when the file states an empty one', () => {
        const core = '<?xml version="1.0"?><cp:coreProperties xmlns:dc="y"><dc:title></dc:title></cp:coreProperties>';
        expect(extractOfficeText(docx(p('Boil it.'), core)).title).toBeUndefined();
    });

    it('flattens the indentation a pretty-printed file carries', () => {
        const body = `<w:p>\n    <w:r>\n      <w:t>Boil the water</w:t>\n    </w:r>\n  </w:p>`;
        expect(extractOfficeText(docx(body)).text).toBe('Boil the water');
    });

    it('refuses an archive that is not a document', () => {
        expect(() => extractOfficeText(zip({ 'notes.txt': 'hello' }))).toThrow(/document\.xml|content\.xml/);
    });

    it('refuses bytes that are not an archive at all', () => {
        expect(() => extractOfficeText(enc.encode('PK\x03\x04 and then nonsense'))).toThrow(
            /not a readable/,
        );
    });
});

describe('extractOfficeText · odt', () => {
    function odt(body: string, meta?: string): Uint8Array {
        return zip({
            mimetype: 'application/vnd.oasis.opendocument.text',
            'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="x" xmlns:text="y"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
            ...(meta ? { 'meta.xml': meta } : {}),
        });
    }

    it('reads paragraphs and outline headings', () => {
        const out = extractOfficeText(
            odt(
                '<text:h text:outline-level="1">Water</text:h><text:p>Boil it for one minute.</text:p>',
            ),
        );
        expect(out.format).toBe('odt');
        expect(out.text).toBe('## Water\nBoil it for one minute.');
    });

    it('reads text through inline spans', () => {
        const body = '<text:p>Boil the <text:span text:style-name="T1">water</text:span> now</text:p>';
        expect(extractOfficeText(odt(body)).text).toBe('Boil the water now');
    });

    it('honours tabs and line breaks', () => {
        const body = '<text:p>One<text:line-break/>Two<text:tab/>Three</text:p>';
        expect(extractOfficeText(odt(body)).text).toBe('One\nTwo Three');
    });

    it('drops annotations', () => {
        const body =
            '<text:p>Boil it.<office:annotation><text:p>check this</text:p></office:annotation></text:p>';
        expect(extractOfficeText(odt(body)).text).toBe('Boil it.');
    });

    it('takes the title from its metadata', () => {
        const meta = '<?xml version="1.0"?><office:document-meta xmlns:dc="y"><dc:title>Water Notes</dc:title></office:document-meta>';
        expect(extractOfficeText(odt('<text:p>Boil it.</text:p>', meta)).title).toBe('Water Notes');
    });
});
