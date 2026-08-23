/**
 * One door into the upload path, for whatever a person happens to have.
 *
 * The formats worth supporting on a mesh node are the ones a document actually
 * arrives in: a PDF of a field guide, a .docx of somebody's notes, a text file.
 * Everything here reduces them to the same thing — plain text with `## ` where
 * the headings were — because that is what the chunker, the embedder and the
 * model downstream all read. Nothing past this module knows what a PDF is.
 *
 * Format is decided by what the bytes say, not by what the name says. An
 * extension is a claim by whoever last renamed the file; a magic number is a
 * statement by whatever wrote it.
 */

import { decodeTextBytes, latin1, winAnsiChar } from './encoding';
import { extractOfficeText } from './officeText';
import { extractPdfText } from './pdfText';

export type DocFormat = 'text' | 'markdown' | 'pdf' | 'docx' | 'odt' | 'rtf' | 'html';

export interface ExtractedDocument {
    text: string;
    /** A title the file stated about itself, where it carried one. */
    title?: string;
    format: DocFormat;
}

/** How the formats are described to somebody choosing a file. */
export const SUPPORTED_FORMATS = '.pdf, .docx, .odt, .rtf, .html, .txt or .md';

export function extractDocument(bytes: Uint8Array, filename = ''): ExtractedDocument {
    if (!bytes.length) throw new Error('that file is empty');

    switch (sniff(bytes)) {
        case 'pdf': {
            const { text, title } = extractPdfText(bytes);
            return { text, title, format: 'pdf' };
        }
        case 'zip': {
            const { text, title, format } = extractOfficeText(bytes);
            if (!text.trim()) throw new Error('that document has no text in it');
            return { text, title, format };
        }
        case 'rtf':
            return { text: requireText(extractRtfText(latin1(bytes))), format: 'rtf' };
        case 'binary':
            throw new Error(
                `this looks like a ${describe(bytes)} rather than a document — ${SUPPORTED_FORMATS} can be read`,
            );
        case 'text': {
            const { text, binary } = decodeTextBytes(bytes);
            if (binary) {
                throw new Error(
                    `this file is not readable as text — ${SUPPORTED_FORMATS} can be read`,
                );
            }
            if (isHtml(text, filename)) {
                return { text: requireText(extractHtmlText(text)), title: htmlTitle(text), format: 'html' };
            }
            return { text: requireText(text), format: markdownish(filename) ? 'markdown' : 'text' };
        }
    }
}

function requireText(text: string): string {
    if (!text.trim()) throw new Error('that document has no text in it');
    return text;
}

/* -------------------------------- sniffing ------------------------------- */

type Sniffed = 'pdf' | 'zip' | 'rtf' | 'text' | 'binary';

/**
 * Formats we can read, and formats we can recognise well enough to refuse by
 * name. The second list earns its place: "this looks like a JPEG" is a sentence
 * somebody can act on, and "not readable as text" is not.
 */
const MAGIC: { bytes: number[]; is: Sniffed; name?: string }[] = [
    { bytes: [0x25, 0x50, 0x44, 0x46], is: 'pdf' }, // %PDF
    { bytes: [0x50, 0x4b, 0x03, 0x04], is: 'zip' }, // a docx/odt, or a plain zip
    { bytes: [0x50, 0x4b, 0x05, 0x06], is: 'zip' }, // an empty archive
    { bytes: [0x7b, 0x5c, 0x72, 0x74], is: 'rtf' }, // {\rt
    { bytes: [0xff, 0xd8, 0xff], is: 'binary', name: 'JPEG image' },
    { bytes: [0x89, 0x50, 0x4e, 0x47], is: 'binary', name: 'PNG image' },
    { bytes: [0x47, 0x49, 0x46, 0x38], is: 'binary', name: 'GIF image' },
    { bytes: [0xd0, 0xcf, 0x11, 0xe0], is: 'binary', name: 'pre-2007 Office file (.doc)' },
    { bytes: [0x1f, 0x8b], is: 'binary', name: 'gzip archive' },
    { bytes: [0x52, 0x61, 0x72, 0x21], is: 'binary', name: 'RAR archive' },
    { bytes: [0x00, 0x61, 0x73, 0x6d], is: 'binary', name: 'WebAssembly module' },
];

function sniff(bytes: Uint8Array): Sniffed {
    for (const entry of MAGIC) {
        if (entry.bytes.every((b, i) => bytes[i] === b)) return entry.is;
    }
    return 'text';
}

function describe(bytes: Uint8Array): string {
    for (const entry of MAGIC) {
        if (entry.name && entry.bytes.every((b, i) => bytes[i] === b)) return entry.name;
    }
    return 'binary file';
}

function markdownish(filename: string): boolean {
    return /\.(md|markdown|mdown)$/i.test(filename);
}

function isHtml(text: string, filename: string): boolean {
    if (/\.(html?|xhtml)$/i.test(filename)) return true;
    return /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(text.slice(0, 2048));
}

/* ---------------------------------- HTML --------------------------------- */

/** Tags after which a line break belongs. */
const HTML_BLOCKS =
    /<\/?(p|div|br|li|tr|hr|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption|nav|aside|main|form)\b[^>]*>/gi;

/**
 * The readable part of a web page.
 *
 * Deliberately not a renderer: no CSS is consulted, so a `display:none` block
 * still comes through. That is the right trade for a document someone chose to
 * save and is about to read on screen before publishing it — and it is why the
 * import lands in an editable body rather than going straight to the mesh.
 */
export function extractHtmlText(html: string): string {
    return decodeHtmlEntities(
        html
            // Scripts, styles and comments are not the page's text, and their
            // contents would otherwise survive tag-stripping intact.
            .replace(/<(script|style|template|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
            .replace(/<\/h[1-6]\s*>/gi, '\n')
            .replace(HTML_BLOCKS, '\n')
            .replace(/<[^>]*>/g, ''),
    )
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function htmlTitle(html: string): string | undefined {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = m ? decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
    return title || undefined;
}

const HTML_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    deg: '°',
    middot: '·',
};

function decodeHtmlEntities(s: string): string {
    if (!s.includes('&')) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
        if (body[0] === '#') {
            const code =
                body[1] === 'x' || body[1] === 'X'
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        }
        return HTML_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/* ---------------------------------- RTF ---------------------------------- */

/**
 * Groups whose contents are settings rather than text.
 *
 * RTF interleaves its font table, colour table and revision bookkeeping with
 * the prose in one brace-nested stream, so a naive strip of control words emits
 * font names and stylesheet entries as if they were sentences.
 */
const RTF_SKIP = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
    'rsidtbl', 'generator', 'info', 'pict', 'object', 'themedata', 'colorschememapping',
    'datastore', 'latentstyles', 'xmlnstbl', 'filetbl', 'header', 'footer', 'pgdsctbl',
]);

/** Control words that are text rather than formatting. */
const RTF_BREAKS = new Set(['par', 'line', 'sect', 'page', 'column']);
const RTF_SPACES = new Set(['tab', 'cell', 'row', 'emspace', 'enspace', 'qmspace']);
const RTF_LITERALS: Record<string, string> = {
    emdash: '—',
    endash: '–',
    bullet: '•',
    lquote: '‘',
    rquote: '’',
    ldblquote: '“',
    rdblquote: '”',
    ltrmark: '',
    rtlmark: '',
};

export function extractRtfText(rtf: string): string {
    const out: string[] = [];
    /** Depth of the group being discarded, once one has started. */
    let skipDepth = 0;
    let depth = 0;
    /** How many characters to drop after a `\uN`: its pre-Unicode fallback. */
    let skipFallback = 0;
    let unicodeSkip = 1;

    for (let i = 0; i < rtf.length; i++) {
        const c = rtf[i];

        if (c === '{') {
            depth++;
            continue;
        }
        if (c === '}') {
            if (skipDepth && depth <= skipDepth) skipDepth = 0;
            depth--;
            continue;
        }

        if (c === '\\') {
            const next = rtf[i + 1];
            // `\*` marks a destination a reader is allowed not to understand.
            if (next === '*') {
                if (!skipDepth) skipDepth = depth;
                i++;
                continue;
            }
            if (next === undefined) break;
            if (!/[a-zA-Z]/.test(next)) {
                // A control symbol: an escaped brace, a backslash, or a byte.
                if (next === "'" ) {
                    const hex = rtf.slice(i + 2, i + 4);
                    i += 3;
                    if (skipFallback > 0) skipFallback--;
                    else if (!skipDepth) out.push(winAnsiChar(parseInt(hex, 16) || 0));
                    continue;
                }
                if (next === '~') {
                    if (!skipDepth) out.push(' ');
                } else if (next === '\n' || next === '\r') {
                    if (!skipDepth) out.push('\n');
                } else if (!skipDepth && (next === '\\' || next === '{' || next === '}')) {
                    out.push(next);
                }
                i++;
                continue;
            }

            let j = i + 1;
            while (j < rtf.length && /[a-zA-Z]/.test(rtf[j])) j++;
            const word = rtf.slice(i + 1, j);
            let arg = '';
            if (rtf[j] === '-' || /[0-9]/.test(rtf[j] ?? '')) {
                const start = j;
                if (rtf[j] === '-') j++;
                while (j < rtf.length && /[0-9]/.test(rtf[j])) j++;
                arg = rtf.slice(start, j);
            }
            // One space after a control word is part of its syntax, not text.
            if (rtf[j] === ' ') j++;
            i = j - 1;

            if (RTF_SKIP.has(word)) {
                if (!skipDepth) skipDepth = depth;
                continue;
            }
            if (skipDepth) continue;

            if (word === 'u') {
                const code = Number(arg);
                if (Number.isFinite(code)) {
                    out.push(String.fromCodePoint(code < 0 ? code + 65536 : code));
                }
                skipFallback = unicodeSkip;
            } else if (word === 'uc') {
                unicodeSkip = Number(arg) || 0;
            } else if (RTF_BREAKS.has(word)) {
                out.push('\n');
            } else if (RTF_SPACES.has(word)) {
                out.push(' ');
            } else if (RTF_LITERALS[word] !== undefined) {
                out.push(RTF_LITERALS[word]);
            }
            continue;
        }

        if (c === '\n' || c === '\r') continue; // layout of the file, not the text
        if (skipDepth) continue;
        if (skipFallback > 0) {
            skipFallback--;
            continue;
        }
        out.push(c);
    }

    return out
        .join('')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
