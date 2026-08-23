/**
 * Text out of the zipped-XML word processor formats: .docx and .odt.
 *
 * Both are a ZIP holding an XML document, so both are the same three steps —
 * unzip one entry, walk its tags, keep the text — and the only real difference
 * is which tags carry a paragraph. They are handled together for that reason
 * rather than because the formats are otherwise alike.
 *
 * Headings come out as `## `, never `# `. `parseDocument` reads a single `# `
 * line as the document's *title*, last one winning, so a file with three
 * top-level headings would name itself after the third and drop the other two
 * out of the body entirely. As sections they all survive, and the title comes
 * from where the author actually stated it.
 */

import { unzipSync } from 'fflate/browser';

export interface OfficeText {
    text: string;
    /** `dc:title` from the file's own metadata, where the author set one. */
    title?: string;
    format: 'docx' | 'odt';
}

/** Entries worth unzipping. A .docx carries fonts and images we never read. */
const WANTED = new Set([
    'word/document.xml',
    'docProps/core.xml',
    'content.xml',
    'meta.xml',
    'mimetype',
]);

export function extractOfficeText(bytes: Uint8Array): OfficeText {
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(bytes, { filter: (f) => WANTED.has(f.name) });
    } catch (e) {
        throw new Error(
            `this file is not a readable .docx or .odt (${e instanceof Error ? e.message : 'unreadable archive'})`,
        );
    }

    if (files['word/document.xml']) {
        return {
            text: walk(utf8(files['word/document.xml']), DOCX),
            title: dcTitle(files['docProps/core.xml']),
            format: 'docx',
        };
    }
    if (files['content.xml']) {
        return {
            text: walk(utf8(files['content.xml']), ODT),
            title: dcTitle(files['meta.xml']),
            format: 'odt',
        };
    }
    throw new Error('this archive holds no document.xml or content.xml to read');
}

/**
 * Which tags mean what, per format.
 *
 * `textIn` exists because the two formats disagree about where the characters
 * live. Word wraps every run of text in `<w:t>`, and everything outside one —
 * field instructions, revision bookkeeping — is machinery that must not reach
 * the page. ODF puts the text straight inside the paragraph, so there is no
 * inner tag to wait for and the answer is "anywhere in here".
 */
interface Dialect {
    /** Starts a block that becomes one line. */
    paragraph: (name: string) => boolean;
    /** Heading level, or 0. Read off the open tag of a paragraph or its style. */
    heading: (name: string, attrs: string) => number;
    /** Only text inside these tags counts; `null` means all of it does. */
    textIn: Set<string> | null;
    lineBreak: Set<string>;
    space: Set<string>;
    /** Subtrees to drop whole — comments, footnote bodies, deleted revisions. */
    skip: Set<string>;
}

const DOCX: Dialect = {
    paragraph: (n) => n === 'w:p',
    // Word keeps the heading level in a style reference inside the paragraph
    // rather than on the paragraph tag, so this fires on `w:pStyle`.
    heading: (n, attrs) => {
        if (n !== 'w:pStyle') return 0;
        const val = attr(attrs, 'w:val') ?? '';
        const m = /^Heading(\d)$/i.exec(val) ?? /^heading\s*(\d)$/i.exec(val);
        return m ? Number(m[1]) : 0;
    },
    textIn: new Set(['w:t']),
    lineBreak: new Set(['w:br', 'w:cr']),
    space: new Set(['w:tab']),
    skip: new Set(['w:instrText', 'w:del', 'w:commentRangeStart']),
};

const ODT: Dialect = {
    paragraph: (n) => n === 'text:p' || n === 'text:h',
    heading: (n, attrs) =>
        n === 'text:h' ? Number(attr(attrs, 'text:outline-level') ?? '1') || 1 : 0,
    textIn: null,
    lineBreak: new Set(['text:line-break']),
    space: new Set(['text:tab', 'text:s']),
    skip: new Set(['office:annotation', 'text:tracked-changes']),
};

/**
 * One pass over the XML, collecting paragraphs.
 *
 * No DOM is built. These documents run to megabytes of XML and the whole job is
 * "concatenate the text in order", which is a scan — materialising a tree first
 * would cost more memory than the file it came from, on a phone.
 */
function walk(xml: string, d: Dialect): string {
    const lines: string[] = [];
    let parts: string[] = [];
    let heading = 0;
    let inParagraph = false;
    let textDepth = d.textIn ? 0 : 1;
    /** Name of the subtree being dropped, and how deep we are inside it. */
    let skipping: { name: string; depth: number } | null = null;

    const flush = () => {
        const text = squeeze(parts.join(''));
        if (text) lines.push(heading ? `## ${text}` : text);
        parts = [];
        heading = 0;
    };

    for (const ev of scanXml(xml)) {
        if (skipping) {
            if (ev.kind === 'open' && ev.name === skipping.name && !ev.selfClosing) {
                skipping.depth++;
            } else if (ev.kind === 'close' && ev.name === skipping.name) {
                if (--skipping.depth === 0) skipping = null;
            }
            continue;
        }

        if (ev.kind === 'text') {
            if (inParagraph && textDepth > 0) parts.push(decodeEntities(ev.text));
            continue;
        }

        if (ev.kind === 'open') {
            if (d.skip.has(ev.name)) {
                if (!ev.selfClosing) skipping = { name: ev.name, depth: 1 };
                continue;
            }
            if (d.paragraph(ev.name)) {
                // A paragraph never nests, but a malformed file should not be
                // able to strand the collector: closing the open one first is
                // both the recovery and the normal path for `<w:p/>`.
                if (inParagraph) flush();
                inParagraph = true;
                heading = d.heading(ev.name, ev.attrs);
                if (ev.selfClosing) {
                    flush();
                    inParagraph = false;
                }
                continue;
            }
            if (inParagraph) {
                const level = d.heading(ev.name, ev.attrs);
                if (level) heading = level;
                if (d.lineBreak.has(ev.name)) parts.push('\n');
                else if (d.space.has(ev.name)) parts.push(' ');
                else if (d.textIn?.has(ev.name) && !ev.selfClosing) textDepth++;
            }
            continue;
        }

        // close
        if (d.paragraph(ev.name) && inParagraph) {
            flush();
            inParagraph = false;
        } else if (d.textIn?.has(ev.name) && textDepth > 0) {
            textDepth--;
        }
    }
    if (inParagraph) flush();

    return lines.join('\n');
}

/** `<dc:title>` out of a metadata part, if the part exists and sets one. */
function dcTitle(part: Uint8Array | undefined): string | undefined {
    if (!part) return undefined;
    const m = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(utf8(part));
    const title = m ? squeeze(decodeEntities(m[1])) : '';
    return title || undefined;
}

/* ------------------------------ XML scanning ----------------------------- */

type XmlEvent =
    | { kind: 'open'; name: string; attrs: string; selfClosing: boolean }
    | { kind: 'close'; name: string }
    | { kind: 'text'; text: string };

/**
 * Tags and text, in order, with no validation.
 *
 * This is not an XML parser and must not be mistaken for one: it does not check
 * that tags nest, resolve namespaces, or read the prolog. It is a tokeniser for
 * files produced by Word and LibreOffice, whose output is well-formed by
 * construction, and its failure mode on anything else is text that comes out
 * odd rather than a document that comes out wrong.
 */
function* scanXml(xml: string): Generator<XmlEvent> {
    let i = 0;
    while (i < xml.length) {
        const lt = xml.indexOf('<', i);
        if (lt < 0) {
            if (i < xml.length) yield { kind: 'text', text: xml.slice(i) };
            return;
        }
        if (lt > i) yield { kind: 'text', text: xml.slice(i, lt) };

        // Comments, CDATA and the prolog: skipped whole, so that a `>` inside
        // one cannot be read as the end of a tag.
        if (xml.startsWith('<!--', lt)) {
            const end = xml.indexOf('-->', lt);
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', lt)) {
            const end = xml.indexOf(']]>', lt);
            const stop = end < 0 ? xml.length : end;
            yield { kind: 'text', text: xml.slice(lt + 9, stop) };
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
            const end = xml.indexOf('>', lt);
            i = end < 0 ? xml.length : end + 1;
            continue;
        }

        const gt = xml.indexOf('>', lt);
        if (gt < 0) return;
        const raw = xml.slice(lt + 1, gt);

        if (raw[0] === '/') {
            yield { kind: 'close', name: raw.slice(1).trim() };
        } else {
            const selfClosing = raw.endsWith('/');
            const body = selfClosing ? raw.slice(0, -1) : raw;
            const sp = body.search(/\s/);
            yield {
                kind: 'open',
                name: (sp < 0 ? body : body.slice(0, sp)).trim(),
                attrs: sp < 0 ? '' : body.slice(sp + 1),
                selfClosing,
            };
        }
        i = gt + 1;
    }
}

function attr(attrs: string, name: string): string | undefined {
    const m = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(attrs);
    return m ? decodeEntities(m[1]) : undefined;
}

const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

function decodeEntities(s: string): string {
    if (!s.includes('&')) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body[0] === '#') {
            const code =
                body[1] === 'x' || body[1] === 'X'
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        }
        return ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/**
 * Whitespace, flattened.
 *
 * Both formats are free to pretty-print their XML, so indentation between
 * elements arrives as text. Collapsing runs of it here means a paragraph reads
 * the same whether or not its producer indented — and non-breaking spaces
 * become ordinary ones, because a passage split on ` ` tokenises as one
 * enormous word.
 */
function squeeze(s: string): string {
    return s.replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function utf8(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}
