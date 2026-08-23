/**
 * Text out of a PDF, on the phone, with no network and no native help.
 *
 * The obvious move is pdf.js, and it is the wrong one here. Its job is to
 * *render* — it wants a DOM, a canvas and a worker, and shimming those onto
 * Hermes to recover a string is a lot of megabytes to ship to a device that may
 * be running on a power bank. Extraction needs a much smaller slice of the
 * format than rendering does: find the content streams, inflate them, and read
 * the text-showing operators. That is what this does.
 *
 * What it handles: the ordinary digitally-produced PDF — cross-reference
 * streams, object streams, Flate and ASCII filters, `ToUnicode` maps, form
 * XObjects, and the 1.4-era layout of the same.
 *
 * What it does not, and says so rather than guessing: encrypted files, and
 * scans. A scan is a picture of a page with no text in it at all, and the
 * failure has to be loud — a document that arrives on the mesh as forty pages
 * of nothing is worse than one that never arrives, because it still ranks, it
 * still replicates, and someone still has to read it to find out.
 */

import { inflateSync, unzlibSync } from 'fflate/browser';

import { latin1, winAnsiChar } from './encoding';

export interface PdfText {
    text: string;
    /** `/Info /Title`, where the producer set one worth having. */
    title?: string;
}

/** Pages read from one file. A cap, so a malformed tree cannot run forever. */
const MAX_PAGES = 500;
/** How deep form XObjects may nest before we assume a cycle. */
const MAX_FORM_DEPTH = 8;
/**
 * How wide a gap has to be, as a fraction of the type size, to be a space.
 *
 * A space in a text face is 0.25–0.33 em, and the pair kerning inside a word is
 * an order of magnitude smaller, so anything past a fifth of an em is a word
 * boundary rather than tight typesetting. One threshold serves both the kerns
 * inside a `TJ` array and the jumps between positioning operators, because
 * after the advance is tracked they are the same measurement.
 */
const SPACE_GAP = 0.2;

/** A glyph whose width the font declines to state. Half an em reads as text. */
const DEFAULT_WIDTH = 500;

export function extractPdfText(bytes: Uint8Array): PdfText {
    const doc = new PdfDocument(bytes);
    if (doc.encrypted) {
        throw new Error('this PDF is password-protected, so its text cannot be read');
    }

    const pages = doc.pages();
    const out: string[] = [];
    for (const page of pages.slice(0, MAX_PAGES)) {
        const content = doc.pageContent(page);
        if (!content) continue;
        const resources = asDict(doc.resolve(page.get('Resources'))) ?? new Map();
        const text = doc.render(content, resources, 0);
        if (text.trim()) out.push(text.trim());
    }

    const text = tidy(out.join('\n\n'));
    if (countLetters(text) < 16) {
        if (!pages.length) throw new Error('no readable pages in this PDF');
        throw new Error(
            doc.undecodableRuns > 0
                ? 'this PDF stores its text as glyph shapes with no character map, so the words cannot be recovered — try exporting it again from whatever produced it'
                : 'this PDF has no text layer — it is probably a scan, and would arrive on the mesh as an empty document',
        );
    }
    return { text, title: doc.title() };
}

/* ------------------------------ object model ----------------------------- */

type Val =
    | { t: 'num'; v: number }
    | { t: 'bool'; v: boolean }
    | { t: 'null' }
    | { t: 'name'; v: string }
    | { t: 'str'; v: Uint8Array }
    | { t: 'ref'; v: number }
    | { t: 'arr'; v: Val[] }
    | { t: 'dict'; v: Dict }
    | { t: 'op'; v: string };

type Dict = Map<string, Val>;

function asDict(v: Val | undefined): Dict | undefined {
    return v?.t === 'dict' ? v.v : undefined;
}
function asNum(v: Val | undefined): number | undefined {
    return v?.t === 'num' ? v.v : undefined;
}
function asName(v: Val | undefined): string | undefined {
    return v?.t === 'name' ? v.v : undefined;
}

/**
 * A PDF's objects, addressed by number.
 *
 * The file is indexed by scanning for `N G obj` rather than by reading the
 * cross-reference table. That sounds like the lazy choice and is in fact the
 * durable one: the xref is the first thing to go stale in a file that has been
 * incrementally updated, linearised or repaired, and every reader in the world
 * already carries a "rebuild by scanning" path for exactly that reason. Scanning
 * unconditionally means there is one path, and it is the one that gets used.
 */
class PdfDocument {
    private readonly raw: string;
    private readonly offsets = new Map<number, number>();
    private readonly cache = new Map<number, Val>();
    /** Objects that live inside an object stream rather than at a file offset. */
    private readonly packed = new Map<number, Val>();
    private readonly streams = new Map<number, Uint8Array | null>();
    private objStmsExpanded = false;
    readonly encrypted: boolean;
    /**
     * Runs of text that were drawn but could not be turned into characters.
     *
     * Counted so that a document producing no text can say *why*. "This is a
     * scan" and "these fonts carry no character map" both come out as an empty
     * string, and they are different problems with different remedies — one
     * needs OCR, the other needs the file exported again from whatever made it.
     */
    undecodableRuns = 0;

    constructor(private readonly bytes: Uint8Array) {
        this.raw = latin1(bytes);

        const re = /(\d+)\s+(\d+)\s+obj\b/g;
        for (let m = re.exec(this.raw); m; m = re.exec(this.raw)) {
            // Later definitions win: an incremental update appends a new version
            // of an object and leaves the old bytes in place ahead of it.
            this.offsets.set(Number(m[1]), m.index + m[0].length);
        }
        this.encrypted = /\/Encrypt\s/.test(this.raw);
    }

    /* ---------------------------- object access --------------------------- */

    resolve(v: Val | undefined): Val | undefined {
        let seen = 0;
        while (v?.t === 'ref') {
            if (++seen > 32) return undefined; // a reference cycle
            v = this.object(v.v);
        }
        return v;
    }

    object(num: number): Val | undefined {
        const hit = this.cache.get(num);
        if (hit) return hit;

        const at = this.offsets.get(num);
        if (at === undefined) {
            if (!this.objStmsExpanded) this.expandObjectStreams();
            return this.packed.get(num);
        }
        const value = new Lexer(this.raw, at).value();
        if (value) this.cache.set(num, value);
        return value;
    }

    /**
     * The decoded bytes of object `num`'s stream, or null if it has none.
     *
     * Only the streams this module reads ever get here — content, object
     * streams, `ToUnicode` maps — so the image filters are deliberately absent
     * rather than stubbed: a JPEG reaching this function is a bug upstream, and
     * returning null for it would hide that.
     */
    stream(num: number): Uint8Array | null {
        const hit = this.streams.get(num);
        if (hit !== undefined) return hit;
        const decoded = this.readStream(num);
        this.streams.set(num, decoded);
        return decoded;
    }

    private readStream(num: number): Uint8Array | null {
        const at = this.offsets.get(num);
        if (at === undefined) return null;

        const lexer = new Lexer(this.raw, at);
        const head = lexer.value();
        const dict = asDict(head);
        if (!dict) return null;

        lexer.ws();
        if (!this.raw.startsWith('stream', lexer.i)) return null;
        let start = lexer.i + 'stream'.length;
        // The keyword is followed by CRLF or LF — never CR alone, and never
        // nothing, but files exist that omit it and the byte count is what
        // actually delimits the data.
        if (this.raw[start] === '\r') start++;
        if (this.raw[start] === '\n') start++;

        const declared = asNum(this.resolve(dict.get('Length')));
        let end = declared !== undefined && declared >= 0 ? start + declared : -1;
        // Trust `/Length` only if `endstream` is where it says it is. A wrong
        // length is the single most common defect in a hand-assembled PDF.
        if (end < 0 || end > this.raw.length || !/^\s*endstream/.test(this.raw.slice(end, end + 20))) {
            const found = this.raw.indexOf('endstream', start);
            if (found < 0) return null;
            end = found;
            while (end > start && (this.raw[end - 1] === '\n' || this.raw[end - 1] === '\r')) end--;
        }

        return decodeFilters(this.bytes.subarray(start, end), dict, this);
    }

    /**
     * Pulls the objects out of every `/Type /ObjStm` in the file.
     *
     * PDF 1.5 moved most non-stream objects — page dictionaries, font
     * dictionaries, the catalog — inside compressed streams, where scanning for
     * `N G obj` cannot see them. Skipping this step does not fail loudly; it
     * fails as a document whose pages all seem to have no fonts.
     */
    private expandObjectStreams(): void {
        this.objStmsExpanded = true;
        for (const num of this.offsets.keys()) {
            const dict = asDict(this.object(num));
            if (!dict || asName(dict.get('Type')) !== 'ObjStm') continue;

            const data = this.stream(num);
            if (!data) continue;
            const body = latin1(data);
            const count = asNum(this.resolve(dict.get('N'))) ?? 0;
            const first = asNum(this.resolve(dict.get('First'))) ?? 0;

            const header = new Lexer(body, 0);
            const entries: { num: number; at: number }[] = [];
            for (let i = 0; i < count; i++) {
                const id = header.value();
                const off = header.value();
                if (id?.t !== 'num' || off?.t !== 'num') break;
                entries.push({ num: id.v, at: first + off.v });
            }
            for (const entry of entries) {
                if (this.offsets.has(entry.num) || this.packed.has(entry.num)) continue;
                const value = new Lexer(body, entry.at).value();
                if (value) this.packed.set(entry.num, value);
            }
        }
    }

    /* ------------------------------- pages -------------------------------- */

    /**
     * Every page, in reading order.
     *
     * Walked from the catalog rather than collected by scanning, because the
     * order is the whole point — object number is assignment order, which for a
     * file written by a word processor is frequently not the order a human read
     * it in. Scanning is the fallback for when the tree is unreachable.
     */
    pages(): Dict[] {
        const out: Dict[] = [];
        const seen = new Set<Dict>();

        // `inherited` stays unresolved — it is whatever the parent held, which
        // is usually a reference, and passing the reference down means a shared
        // resource dictionary is resolved (and its fonts parsed) once.
        const visit = (node: Dict | undefined, inherited: Val | undefined, depth: number) => {
            if (!node || out.length >= MAX_PAGES || depth > 64 || seen.has(node)) return;
            seen.add(node);

            // Resources, MediaBox and Rotate are inheritable: a page that omits
            // them takes its parent's. Only Resources matters for text, but it
            // matters a lot — a page with no font map decodes to nothing.
            const resources = node.get('Resources') ?? inherited;
            const type = asName(node.get('Type'));
            const kids = this.resolve(node.get('Kids'));

            if (type === 'Page' || (type !== 'Pages' && !kids)) {
                if (resources && !node.has('Resources')) node.set('Resources', resources);
                out.push(node);
                return;
            }
            if (kids?.t !== 'arr') return;
            for (const kid of kids.v) visit(asDict(this.resolve(kid)), resources, depth + 1);
        };

        const root = asDict(this.resolve(this.trailer()?.get('Root')));
        visit(asDict(this.resolve(root?.get('Pages'))), undefined, 0);
        if (out.length) return out;

        // No usable tree. Take every page object there is, in file order.
        if (!this.objStmsExpanded) this.expandObjectStreams();
        const nums = [...new Set([...this.offsets.keys(), ...this.packed.keys()])].sort((a, b) => a - b);
        for (const num of nums) {
            const dict = asDict(this.object(num));
            if (dict && asName(dict.get('Type')) === 'Page') out.push(dict);
            if (out.length >= MAX_PAGES) break;
        }
        return out;
    }

    /** A page's content streams, concatenated. */
    pageContent(page: Dict): string | null {
        const contents = page.get('Contents');
        const refs: number[] = [];
        const collect = (v: Val | undefined) => {
            if (v?.t === 'ref') refs.push(v.v);
            else if (v?.t === 'arr') for (const item of v.v) collect(item);
        };
        collect(contents);
        // An inline (non-referenced) content array is legal but vanishingly
        // rare; resolving through it here keeps the shape one code path.
        if (!refs.length) {
            const direct = this.resolve(contents);
            if (direct?.t === 'arr') for (const item of direct.v) collect(item);
        }

        const parts: string[] = [];
        for (const ref of refs) {
            const data = this.stream(ref);
            if (data) parts.push(latin1(data));
        }
        return parts.length ? parts.join('\n') : null;
    }

    private trailerCache: Dict | null | undefined;

    /** The trailer dict, however this file chose to record one. */
    private trailer(): Dict | undefined {
        if (this.trailerCache !== undefined) return this.trailerCache ?? undefined;
        this.trailerCache = null;

        // Classic trailers, last first: the newest update is at the end.
        const found: number[] = [];
        for (let i = this.raw.indexOf('trailer'); i >= 0; i = this.raw.indexOf('trailer', i + 1)) {
            found.push(i);
        }
        for (const at of found.reverse()) {
            const dict = asDict(new Lexer(this.raw, at + 'trailer'.length).value());
            if (dict?.has('Root')) {
                this.trailerCache = dict;
                return dict;
            }
        }

        // A 1.5+ file keeps the same keys in its cross-reference *stream*.
        for (const num of this.offsets.keys()) {
            const dict = asDict(this.object(num));
            if (dict?.has('Root') && asName(dict.get('Type')) === 'XRef') {
                this.trailerCache = dict;
                return dict;
            }
        }
        // Last resort: the catalog itself, which is what Root points at.
        for (const num of this.offsets.keys()) {
            const dict = asDict(this.object(num));
            if (dict && asName(dict.get('Type')) === 'Catalog') {
                const synthetic: Dict = new Map([['Root', { t: 'ref', v: num } as Val]]);
                this.trailerCache = synthetic;
                return synthetic;
            }
        }
        return undefined;
    }

    title(): string | undefined {
        const info = asDict(this.resolve(this.trailer()?.get('Info')));
        const raw = this.resolve(info?.get('Title'));
        if (raw?.t !== 'str') return undefined;
        const title = decodeTextString(raw.v).trim();
        // Producers routinely write the temp filename, or nothing worth having.
        return title && !/^untitled$/i.test(title) ? title : undefined;
    }

    /* ------------------------------ rendering ----------------------------- */

    /**
     * Reads one content stream, in the order a renderer would draw it.
     *
     * The hard part is not the characters, it is the spaces. Plenty of
     * producers never write a space character at all: Chrome positions every
     * single glyph with its own `Td`, and a typesetter draws a word and then
     * jumps the pen to where the next one starts. So the text matrix is tracked
     * for real, glyph advances are accumulated out of the font's own width
     * table, and a space is emitted where the pen moved further than drawing
     * the previous glyphs accounts for. The cheap alternative — a space per
     * positioning operator — turns a page of Chrome's output into "s p a C y".
     *
     * Layout is not reconstructed beyond that. Columns, tables and reading
     * order across a spread are a much larger problem, and getting them
     * half-right produces text that looks fine and says something the page did
     * not. Lines, words and paragraphs are what the chunker needs, and they are
     * what is claimed here.
     */
    render(content: string, resources: Dict, depth: number, ctm: Matrix = IDENTITY): string {
        const fonts = this.fontsOf(resources);
        const out: string[] = [];
        const lexer = new Lexer(content, 0);
        const stack: Val[] = [];

        let font: Font | undefined;
        let tm: Matrix = IDENTITY;
        let tlm: Matrix = IDENTITY;
        const graphics: Matrix[] = [];
        let gs = ctm;

        let size = 0;
        let charSpacing = 0;
        let wordSpacing = 0;
        let hscale = 1;
        let leading = 0;
        /** Where the pen was left by the last thing drawn. */
        let penX: number | undefined;
        let penY = 0;

        const operands = (n: number): number[] => stack.slice(-n).map((v) => asNum(v) ?? 0);
        const push = (s: string) => {
            if (s) out.push(s);
        };
        const newline = () => {
            if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n');
        };

        /**
         * Reconciles the pen with wherever the matrix now points.
         *
         * A vertical move is a new line. A forward jump wider than a fraction of
         * the type size is the gap between two words — that is the whole reason
         * the advance is tracked. A jump backwards is a carriage return that the
         * producer expressed as an absolute position.
         */
        const moved = () => {
            const [x, y] = origin(tm, gs);
            const em = emSize(tm, gs, size);
            if (penX !== undefined && em > 0) {
                if (Math.abs(y - penY) > 0.4 * em) newline();
                else if (x - penX > SPACE_GAP * em) push(' ');
                // Generous, because the width table is an estimate wherever a
                // glyph is missing from it: a genuine carriage return travels
                // back across the whole measure, not by a character or two.
                else if (penX - x > 3 * em) newline();
            }
            penX = x;
            penY = y;
        };

        /** Moves the pen along the current line by `w`, in text-space units. */
        const advance = (w: number) => {
            tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + w * tm[0], tm[5] + w * tm[1]];
            [penX, penY] = origin(tm, gs);
        };

        /** Draws a string, then advances the pen by what it covered. */
        const show = (v: Val | undefined) => {
            if (v?.t !== 'str') return;
            if (v.v.length && font && undecodable(font)) this.undecodableRuns++;
            moved();
            push(decodeShownText(v.v, font));
            advance(textWidth(v.v, font, size, charSpacing, wordSpacing) * hscale);
        };

        const nextLine = (tx: number, ty: number) => {
            tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
            tm = tlm;
        };

        for (let token = lexer.token(); token; token = lexer.token()) {
            if (token.t !== 'op') {
                if (stack.length < 64) stack.push(token);
                continue;
            }
            switch (token.v) {
                case 'q':
                    graphics.push(gs);
                    break;
                case 'Q':
                    gs = graphics.pop() ?? gs;
                    break;
                case 'cm': {
                    const m = operands(6);
                    if (m.length === 6) gs = multiply(m as Matrix, gs);
                    break;
                }
                case 'BT':
                    tm = tlm = IDENTITY;
                    penX = undefined;
                    break;
                case 'ET':
                    newline();
                    penX = undefined;
                    break;
                case 'Tf':
                    font = fonts.get(asName(stack[stack.length - 2]) ?? '');
                    size = asNum(stack[stack.length - 1]) ?? 0;
                    break;
                case 'Tc':
                    charSpacing = asNum(stack[stack.length - 1]) ?? 0;
                    break;
                case 'Tw':
                    wordSpacing = asNum(stack[stack.length - 1]) ?? 0;
                    break;
                case 'Tz':
                    hscale = (asNum(stack[stack.length - 1]) ?? 100) / 100;
                    break;
                case 'TL':
                    leading = asNum(stack[stack.length - 1]) ?? 0;
                    break;
                case 'Td': {
                    const [tx, ty] = operands(2);
                    nextLine(tx ?? 0, ty ?? 0);
                    break;
                }
                case 'TD': {
                    const [tx, ty] = operands(2);
                    leading = -(ty ?? 0);
                    nextLine(tx ?? 0, ty ?? 0);
                    break;
                }
                case 'Tm': {
                    const m = operands(6);
                    if (m.length === 6) tlm = tm = m as Matrix;
                    break;
                }
                case 'T*':
                    nextLine(0, -leading);
                    break;
                case 'Tj':
                    show(stack[stack.length - 1]);
                    break;
                case "'":
                    nextLine(0, -leading);
                    show(stack[stack.length - 1]);
                    break;
                case '"':
                    wordSpacing = asNum(stack[stack.length - 3]) ?? wordSpacing;
                    charSpacing = asNum(stack[stack.length - 2]) ?? charSpacing;
                    nextLine(0, -leading);
                    show(stack[stack.length - 1]);
                    break;
                case 'TJ': {
                    const arr = stack[stack.length - 1];
                    if (arr?.t !== 'arr') break;
                    for (const item of arr.v) {
                        if (item.t === 'str') {
                            show(item);
                        } else if (item.t === 'num') {
                            // A kern, in thousandths of an em, positive to the
                            // left. Far enough to the left is a word gap.
                            if (-item.v > SPACE_GAP * 1000) push(' ');
                            advance((-item.v / 1000) * size * hscale);
                        }
                    }
                    break;
                }
                case 'BI':
                    lexer.skipInlineImage();
                    break;
                case 'Do': {
                    if (depth >= MAX_FORM_DEPTH) break;
                    const name = asName(stack[stack.length - 1]);
                    const nested = name ? this.formXObject(resources, name) : undefined;
                    if (nested) {
                        push(this.render(nested.content, nested.resources ?? resources, depth + 1, gs));
                        penX = undefined;
                    }
                    break;
                }
                default:
                    break;
            }
            stack.length = 0;
        }
        return out.join('');
    }

    /** A form XObject's stream and its own resources, if `name` names one. */
    private formXObject(
        resources: Dict,
        name: string,
    ): { content: string; resources?: Dict } | undefined {
        const xobjects = asDict(this.resolve(resources.get('XObject')));
        const ref = xobjects?.get(name);
        if (ref?.t !== 'ref') return undefined;
        const dict = asDict(this.object(ref.v));
        if (!dict || asName(dict.get('Subtype')) !== 'Form') return undefined;
        const data = this.stream(ref.v);
        if (!data) return undefined;
        return { content: latin1(data), resources: asDict(this.resolve(dict.get('Resources'))) };
    }

    private readonly fontCache = new Map<Dict, Map<string, Font>>();

    /** Resource name (`/F1`) to what it takes to decode that font's bytes. */
    private fontsOf(resources: Dict): Map<string, Font> {
        const hit = this.fontCache.get(resources);
        if (hit) return hit;

        const fonts = new Map<string, Font>();
        const dict = asDict(this.resolve(resources.get('Font')));
        for (const [name, ref] of dict ?? []) {
            const font = asDict(this.resolve(ref));
            if (!font) continue;

            const toUnicode = font.get('ToUnicode');
            const data = toUnicode?.t === 'ref' ? this.stream(toUnicode.v) : null;
            const cmap = data ? parseCMap(latin1(data)) : undefined;
            // A composite font's codes are two bytes wide by definition, and
            // that beats anything the `ToUnicode` map appears to say. Producers
            // write those maps with two-digit source codes often enough, and
            // reading an Identity-H string one byte at a time returns a
            // plausible-looking string of entirely the wrong characters — the
            // worst failure available here, because nothing downstream can tell.
            const composite = asName(this.resolve(font.get('Subtype'))) === 'Type0';
            fonts.set(name, {
                cmap,
                bytesPerCode: composite ? 2 : (cmap?.bytesPerCode ?? 1),
                composite,
                ...(composite ? this.cidWidths(font) : this.simpleWidths(font)),
            });
        }
        this.fontCache.set(resources, fonts);
        return fonts;
    }

    /**
     * `/Widths`, indexed from `/FirstChar` — the simple-font width table.
     *
     * Type 3 is the exception that has to be handled rather than ignored, and
     * it is not a rare one: printing a web page from Chrome produces a document
     * whose every font is Type 3. Its widths are in glyph space, which the font
     * defines for itself through `/FontMatrix`, so they mean nothing until they
     * are put through it — read raw they are wrong by whatever factor that
     * matrix applies, and every gap measured against them is wrong with them.
     */
    private simpleWidths(font: Dict): { widths: Map<number, number>; defaultWidth: number } {
        const widths = new Map<number, number>();
        const list = this.resolve(font.get('Widths'));
        const first = asNum(this.resolve(font.get('FirstChar'))) ?? 0;

        // 1000 because the rest of this module counts in thousandths of an em,
        // which is the same statement as the default matrix of 0.001.
        let scale = 1;
        if (asName(this.resolve(font.get('Subtype'))) === 'Type3') {
            const matrix = this.resolve(font.get('FontMatrix'));
            const a = matrix?.t === 'arr' ? asNum(this.resolve(matrix.v[0])) : undefined;
            scale = (a ?? 0.001) * 1000;
        }

        if (list?.t === 'arr') {
            list.v.forEach((w, i) => {
                const width = asNum(this.resolve(w));
                if (width !== undefined && width > 0) widths.set(first + i, width * scale);
            });
        }
        const descriptor = asDict(this.resolve(font.get('FontDescriptor')));
        const missing = asNum(this.resolve(descriptor?.get('MissingWidth')));
        return { widths, defaultWidth: missing ?? DEFAULT_WIDTH };
    }

    /**
     * `/W` on the descendant font: the composite-font width table.
     *
     * Two shapes share the one array — `c [w w w]` numbers a run of consecutive
     * codes, and `first last w` gives one width to a whole range — so it is read
     * by looking at what follows each code rather than by position.
     */
    private cidWidths(font: Dict): { widths: Map<number, number>; defaultWidth: number } {
        const widths = new Map<number, number>();
        const descendants = this.resolve(font.get('DescendantFonts'));
        const child = asDict(this.resolve(descendants?.t === 'arr' ? descendants.v[0] : undefined));
        const list = this.resolve(child?.get('W'));

        if (list?.t === 'arr') {
            const items = list.v.map((v) => this.resolve(v));
            for (let i = 0; i < items.length; ) {
                const start = asNum(items[i]);
                const next = items[i + 1];
                if (start === undefined || next === undefined) break;
                if (next.t === 'arr') {
                    next.v.forEach((w, k) => {
                        const width = asNum(this.resolve(w));
                        if (width !== undefined && width > 0) widths.set(start + k, width);
                    });
                    i += 2;
                } else {
                    const last = asNum(next);
                    const width = asNum(items[i + 2]);
                    if (last === undefined || width === undefined) break;
                    // A range can legally span the whole code space; only the
                    // part of it a document could plausibly use is worth storing.
                    for (let code = start; code <= last && code - start < 65536; code++) {
                        if (width > 0) widths.set(code, width);
                    }
                    i += 3;
                }
            }
        }
        const dw = asNum(this.resolve(child?.get('DW')));
        return { widths, defaultWidth: dw ?? 1000 };
    }
}

/* -------------------------------- decoding ------------------------------- */

interface CMap {
    map: Map<number, string>;
    bytesPerCode: 1 | 2;
}

interface Font {
    cmap?: CMap;
    bytesPerCode: 1 | 2;
    composite: boolean;
    /** Character code to advance width, in thousandths of an em. */
    widths: Map<number, number>;
    defaultWidth: number;
}

/* -------------------------------- geometry ------------------------------- */

/** `[a, b, c, d, e, f]`, the six numbers PDF uses for an affine transform. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ];
}

/** Where the text matrix currently puts the pen, on the page. */
function origin(tm: Matrix, ctm: Matrix): [number, number] {
    const m = multiply(tm, ctm);
    return [m[4], m[5]];
}

/**
 * The type size as it lands on the page.
 *
 * `Tf` is only half the answer: plenty of producers set a size of 1 and put the
 * real scale in the text matrix, so comparing a gap against `Tf` alone would
 * measure it against nothing. This is the vertical scale of the combined
 * matrix, which is the size the reader actually sees.
 */
function emSize(tm: Matrix, ctm: Matrix, fontSize: number): number {
    const m = multiply(tm, ctm);
    return Math.abs(fontSize) * Math.hypot(m[2], m[3]);
}

/**
 * How far drawing `bytes` moves the pen, in text-space units.
 *
 * Widths come from the font's own table. Where a font declines to supply one —
 * the fourteen standard faces are allowed to, since every viewer is assumed to
 * know them — half an em stands in. That is an approximation, but only the
 * *gaps between* runs are read off it, and a font with no widths is invariably
 * one of the standard faces, which write their spaces as real characters.
 */
function textWidth(
    bytes: Uint8Array,
    font: Font | undefined,
    size: number,
    charSpacing: number,
    wordSpacing: number,
): number {
    if (!font) return 0;
    const step = font.bytesPerCode;
    let total = 0;
    for (let i = 0; i < bytes.length; i += step) {
        const code = step === 2 ? (bytes[i] << 8) | (bytes[i + 1] ?? 0) : bytes[i];
        const width = font.widths.get(code) ?? font.defaultWidth;
        total += (width / 1000) * size + charSpacing;
        // Word spacing applies to the single byte 32, and never to a two-byte
        // code that merely happens to end in it.
        if (step === 1 && code === 32) total += wordSpacing;
    }
    return total;
}

/**
 * Whether this font's bytes can be turned into characters at all.
 *
 * A subsetted composite font encodes glyph indices — "1, 2, 3" for whichever
 * glyphs the subsetter kept — so without a `ToUnicode` map there is nothing to
 * decode against. Producers do ship the map as an empty stub, declaring a
 * codespace and then listing nothing, which is the same thing as absent.
 */
function undecodable(font: Font): boolean {
    return font.composite && !font.cmap?.map.size;
}

/**
 * A `ToUnicode` CMap: the font's own statement of what its codes mean.
 *
 * Without one, a subsetted font's bytes are glyph indices in an arbitrary order
 * — "1, 2, 3" for whichever three letters the subsetter happened to keep — and
 * no amount of care recovers text from them. This is the difference between
 * reading a PDF and guessing at it.
 */
function parseCMap(src: string): CMap {
    const map = new Map<number, string>();
    let bytesPerCode: 1 | 2 = 1;

    const noteWidth = (hex: string) => {
        if (hex.length > 2) bytesPerCode = 2;
    };

    const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
    for (let block = charRe.exec(src); block; block = charRe.exec(src)) {
        const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
        for (let m = pairRe.exec(block[1]); m; m = pairRe.exec(block[1])) {
            noteWidth(m[1]);
            map.set(parseInt(m[1], 16), utf16be(m[2]));
        }
    }

    const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    for (let block = rangeRe.exec(src); block; block = rangeRe.exec(src)) {
        const body = block[1];
        // `<lo> <hi> [<a> <b> …]` — one destination per code in the range.
        const listRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
        const consumed: [number, number][] = [];
        for (let m = listRe.exec(body); m; m = listRe.exec(body)) {
            noteWidth(m[1]);
            const lo = parseInt(m[1], 16);
            const items = m[3].match(/<([0-9a-fA-F]*)>/g) ?? [];
            items.forEach((item, i) => map.set(lo + i, utf16be(item.slice(1, -1))));
            consumed.push([m.index, m.index + m[0].length]);
        }
        // `<lo> <hi> <dst>` — consecutive codes onto consecutive characters.
        const spanRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
        for (let m = spanRe.exec(body); m; m = spanRe.exec(body)) {
            if (consumed.some(([from, to]) => m!.index >= from && m!.index < to)) continue;
            noteWidth(m[1]);
            const lo = parseInt(m[1], 16);
            const hi = parseInt(m[2], 16);
            const dst = utf16be(m[3]);
            const base = dst.codePointAt(dst.length - 1) ?? 0;
            const prefix = dst.slice(0, dst.length - 1);
            for (let code = lo; code <= hi && code - lo < 65536; code++) {
                map.set(code, prefix + String.fromCodePoint(base + (code - lo)));
            }
        }
    }
    return { map, bytesPerCode };
}

/** UTF-16BE hex, as the destination of a CMap entry. */
function utf16be(hex: string): string {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
        const unit = parseInt(hex.slice(i, i + 4), 16);
        if (Number.isFinite(unit)) out += String.fromCharCode(unit);
    }
    return out;
}

/**
 * The bytes of a shown string, as characters.
 *
 * A font with no `ToUnicode` is assumed to be using a single-byte encoding
 * close enough to WinAnsi to read, which is true of the fonts that ship with
 * every viewer and of most simple embedded ones. A composite font with no map
 * is the case that cannot be read, and it returns nothing so that the
 * empty-document check downstream catches it.
 */
function decodeShownText(bytes: Uint8Array, font: Font | undefined): string {
    const width = font?.bytesPerCode ?? 1;
    const cmap = font?.cmap?.map.size ? font.cmap : undefined;

    if (!cmap) {
        if (font?.composite) return '';
        let out = '';
        for (const b of bytes) out += winAnsiChar(b);
        return out;
    }

    let out = '';
    for (let i = 0; i < bytes.length; i += width) {
        const code = width === 2 ? (bytes[i] << 8) | (bytes[i + 1] ?? 0) : bytes[i];
        const mapped = cmap.map.get(code);
        if (mapped !== undefined) out += mapped;
        else if (width === 1) out += winAnsiChar(code);
    }
    return out;
}

/** A PDF *text string*: UTF-16BE when it carries a byte-order mark, else PDFDoc. */
function decodeTextString(bytes: Uint8Array): string {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        let out = '';
        for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        return out;
    }
    let out = '';
    for (const b of bytes) out += winAnsiChar(b);
    return out;
}

/* -------------------------------- filters -------------------------------- */

function decodeFilters(data: Uint8Array, dict: Dict, doc: PdfDocument): Uint8Array | null {
    const filter = doc.resolve(dict.get('Filter'));
    const names =
        filter?.t === 'name'
            ? [filter.v]
            : filter?.t === 'arr'
              ? filter.v.map((f) => asName(f) ?? '')
              : [];

    let out = data;
    for (const name of names) {
        switch (name) {
            case 'FlateDecode':
            case 'Fl':
                out = inflate(out);
                break;
            case 'ASCIIHexDecode':
            case 'AHx':
                out = asciiHex(out);
                break;
            case 'ASCII85Decode':
            case 'A85':
                out = ascii85(out);
                break;
            case '':
                break;
            default:
                // An image codec, or something this does not implement. Either
                // way there is no text in it.
                return null;
        }
    }
    return out;
}

/**
 * Flate, with or without the zlib wrapper.
 *
 * The specification says zlib. Enough producers emit a raw deflate stream, or
 * put a byte of whitespace in front of the header, that a reader which insists
 * on the specification loses documents to it.
 */
function inflate(data: Uint8Array): Uint8Array {
    try {
        return unzlibSync(data);
    } catch {
        try {
            return inflateSync(data);
        } catch {
            let start = 0;
            while (start < data.length && data[start] <= 0x20) start++;
            if (start === 0 || start >= data.length) return new Uint8Array(0);
            try {
                return unzlibSync(data.subarray(start));
            } catch {
                return new Uint8Array(0);
            }
        }
    }
}

function asciiHex(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    let hi = -1;
    for (const b of data) {
        if (b === 0x3e) break; // '>'
        const d = hexDigit(b);
        if (d < 0) continue;
        if (hi < 0) hi = d;
        else {
            out.push((hi << 4) | d);
            hi = -1;
        }
    }
    if (hi >= 0) out.push(hi << 4);
    return Uint8Array.from(out);
}

function hexDigit(b: number): number {
    if (b >= 0x30 && b <= 0x39) return b - 0x30;
    if (b >= 0x41 && b <= 0x46) return b - 0x37;
    if (b >= 0x61 && b <= 0x66) return b - 0x57;
    return -1;
}

function ascii85(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    let tuple = 0;
    let count = 0;
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (c === 0x7e) break; // '~>'
        if (c <= 0x20) continue;
        if (c === 0x7a && count === 0) {
            out.push(0, 0, 0, 0);
            continue;
        }
        if (c < 0x21 || c > 0x75) continue;
        tuple = tuple * 85 + (c - 0x21);
        if (++count === 5) {
            out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
            tuple = 0;
            count = 0;
        }
    }
    if (count > 1) {
        for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
        const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
        out.push(...bytes.slice(0, count - 1));
    }
    return Uint8Array.from(out);
}

/* --------------------------------- lexer --------------------------------- */

const DELIMITERS = new Set('()<>[]{}/%'.split(''));

/**
 * One tokeniser for both jobs.
 *
 * A PDF object and a page's content stream are the same syntax used for two
 * purposes — the second one just has bare operators between the operands. So
 * `value()` is `token()` with the operators refused, and there is one place
 * where string escapes and hex digits are understood.
 */
class Lexer {
    constructor(
        private readonly s: string,
        public i = 0,
    ) {}

    ws(): void {
        while (this.i < this.s.length) {
            const c = this.s[this.i];
            if (c === '%') {
                while (this.i < this.s.length && this.s[this.i] !== '\n' && this.s[this.i] !== '\r') {
                    this.i++;
                }
            } else if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') {
                this.i++;
            } else {
                return;
            }
        }
    }

    /** The next object, or undefined at an operator or the end. */
    value(): Val | undefined {
        const token = this.token();
        return token && token.t !== 'op' ? token : undefined;
    }

    token(): Val | undefined {
        this.ws();
        if (this.i >= this.s.length) return undefined;
        const c = this.s[this.i];

        if (c === '<') {
            if (this.s[this.i + 1] === '<') return this.dict();
            return this.hexString();
        }
        if (c === '(') return this.literalString();
        if (c === '[') return this.array();
        if (c === '/') return this.name();
        if (c === ']' || c === '>' || c === '}' || c === ')') {
            this.i++; // stray close: skip rather than stall
            return this.token();
        }
        if (c === '{') {
            this.i++;
            return this.token();
        }
        if ((c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.') return this.numberOrRef();

        // A bare keyword: an operator, or one of the three literals.
        const start = this.i;
        while (this.i < this.s.length && !isSpace(this.s[this.i]) && !DELIMITERS.has(this.s[this.i])) {
            this.i++;
        }
        if (this.i === start) {
            this.i++;
            return this.token();
        }
        const word = this.s.slice(start, this.i);
        if (word === 'true') return { t: 'bool', v: true };
        if (word === 'false') return { t: 'bool', v: false };
        if (word === 'null') return { t: 'null' };
        return { t: 'op', v: word };
    }

    private dict(): Val {
        this.i += 2;
        const map: Dict = new Map();
        for (;;) {
            this.ws();
            if (this.i >= this.s.length) break;
            if (this.s.startsWith('>>', this.i)) {
                this.i += 2;
                break;
            }
            if (this.s[this.i] !== '/') {
                // Not a key. Consume one token so a damaged dict cannot loop.
                if (!this.token()) break;
                continue;
            }
            const key = this.name().v;
            const value = this.token();
            if (!value) break;
            if (value.t !== 'op') map.set(key, value);
        }
        return { t: 'dict', v: map };
    }

    private array(): Val {
        this.i++;
        const items: Val[] = [];
        for (;;) {
            this.ws();
            if (this.i >= this.s.length) break;
            if (this.s[this.i] === ']') {
                this.i++;
                break;
            }
            const value = this.token();
            if (!value) break;
            if (value.t !== 'op') items.push(value);
            if (items.length > 100000) break;
        }
        return { t: 'arr', v: items };
    }

    private name(): { t: 'name'; v: string } {
        this.i++;
        const start = this.i;
        while (this.i < this.s.length && !isSpace(this.s[this.i]) && !DELIMITERS.has(this.s[this.i])) {
            this.i++;
        }
        const raw = this.s.slice(start, this.i);
        // `#` escapes are how a name holds a space or a delimiter.
        return { t: 'name', v: raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw };
    }

    private numberOrRef(): Val {
        const start = this.i;
        if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
        while (this.i < this.s.length && /[0-9.\-+eE]/.test(this.s[this.i])) this.i++;
        const value = Number(this.s.slice(start, this.i));
        const num: Val = { t: 'num', v: Number.isFinite(value) ? value : 0 };

        // `12 0 R` is a reference, and is only distinguishable by looking ahead.
        if (Number.isInteger(value) && value > 0) {
            const save = this.i;
            const ahead = /^\s+\d+\s+R(?![a-zA-Z0-9])/.exec(this.s.slice(this.i, this.i + 24));
            if (ahead) {
                this.i += ahead[0].length;
                return { t: 'ref', v: value };
            }
            this.i = save;
        }
        return num;
    }

    private hexString(): Val {
        this.i++;
        const out: number[] = [];
        let hi = -1;
        while (this.i < this.s.length && this.s[this.i] !== '>') {
            const d = hexDigit(this.s.charCodeAt(this.i));
            this.i++;
            if (d < 0) continue;
            if (hi < 0) hi = d;
            else {
                out.push((hi << 4) | d);
                hi = -1;
            }
        }
        if (hi >= 0) out.push(hi << 4);
        this.i++;
        return { t: 'str', v: Uint8Array.from(out) };
    }

    private literalString(): Val {
        this.i++;
        const out: number[] = [];
        let depth = 1;
        while (this.i < this.s.length) {
            const c = this.s[this.i++];
            if (c === '\\') {
                const e = this.s[this.i++];
                switch (e) {
                    case 'n': out.push(10); break;
                    case 'r': out.push(13); break;
                    case 't': out.push(9); break;
                    case 'b': out.push(8); break;
                    case 'f': out.push(12); break;
                    case '\n': break; // a line continuation
                    case '\r': if (this.s[this.i] === '\n') this.i++; break;
                    default:
                        if (e >= '0' && e <= '7') {
                            let oct = e;
                            while (oct.length < 3 && this.s[this.i] >= '0' && this.s[this.i] <= '7') {
                                oct += this.s[this.i++];
                            }
                            out.push(parseInt(oct, 8) & 0xff);
                        } else if (e !== undefined) {
                            out.push(e.charCodeAt(0) & 0xff);
                        }
                }
                continue;
            }
            if (c === '(') depth++;
            else if (c === ')' && --depth === 0) break;
            out.push(c.charCodeAt(0) & 0xff);
        }
        return { t: 'str', v: Uint8Array.from(out) };
    }

    /**
     * Steps over an inline image.
     *
     * Its data sits raw in the content stream between `ID` and `EI` with no
     * length anywhere, so a tokeniser that does not know to jump it will read
     * compressed pixels as operators — and occasionally find a `(` in them and
     * swallow the rest of the page as a string.
     */
    skipInlineImage(): void {
        const id = this.s.indexOf('ID', this.i);
        if (id < 0) {
            this.i = this.s.length;
            return;
        }
        let at = id + 2;
        if (isSpace(this.s[at])) at++;
        for (;;) {
            const ei = this.s.indexOf('EI', at);
            if (ei < 0) {
                this.i = this.s.length;
                return;
            }
            const before = this.s[ei - 1];
            const after = this.s[ei + 2];
            if (isSpace(before) && (after === undefined || isSpace(after) || DELIMITERS.has(after))) {
                this.i = ei + 2;
                return;
            }
            at = ei + 2;
        }
    }
}

function isSpace(c: string | undefined): boolean {
    return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
}

/* -------------------------------- clean-up ------------------------------- */

function tidy(text: string): string {
    return (
        text
            .replace(/\r\n?/g, '\n')
            // A soft hyphen, and a hard one left at a line break by
            // justification. Rejoined only into a lower-case continuation, so
            // "well-\nknown" keeps its hyphen and "hyphen-\nation" loses it.
            .replace(/­/g, '')
            .replace(/([a-z])-\n([a-z])/g, '$1$2')
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            // Rejoin a sentence the page broke across two lines. A PDF's line
            // endings are typography, not structure — the chunker splits on
            // them, so leaving them in cuts sentences in half and embeds the
            // halves separately. A line starting lower-case after one that did
            // not end is a continuation; anything else is left alone, which
            // keeps headings, list items and real paragraph breaks intact.
            .replace(/(\p{L}|,)\n(?=\p{Ll})/gu, '$1 ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    );
}

function countLetters(text: string): number {
    let n = 0;
    for (const ch of text) {
        if (/\p{L}/u.test(ch)) n++;
        if (n >= 16) return n;
    }
    return n;
}
