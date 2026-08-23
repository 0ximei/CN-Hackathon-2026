import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { parseDocument } from '@core/lib/chunk';
import { extractDocument } from '@core/lib/extract';

import { fromBase64 } from '../../lib/base64';

/**
 * Picking a file and turning it into a document, with no screen involved.
 *
 * This used to live inside the composer, which meant importing a file was a way
 * of *starting a draft*: the extracted text landed in the body field and the
 * author published it from there. That is the right shape for text somebody is
 * writing and the wrong one for a file they already have — a fifty-page PDF is
 * not a first draft, and dropping it into an editor asks the author to proof
 * something they never wrote before it will move.
 *
 * So the two are separate now, and this is the half with no author in it. It
 * reads a file and reports what it found; publishing is the caller's business.
 */

export interface ImportedDocument {
    /** The original filename, which is what `source` records. */
    name: string;
    /** Stated by the file, else taken from its own headings, else its name. */
    title: string;
    text: string;
    format: string;
    /**
     * One line saying what was read, for the caller to show afterwards.
     *
     * Not a gate and not a success message. Extraction is a *reading* of a
     * document rather than the document, and how good a reading it is depends
     * entirely on the format it came from — so the one thing worth saying is
     * which format that was.
     */
    note: string;
}

/**
 * A result rather than an exception, because cancelling is not a failure.
 *
 * The picker returns "the user changed their mind" through the same call as
 * "that file is unreadable", and a caller that catches both the same way either
 * shows an error nobody caused or swallows one that matters.
 */
export type ImportResult =
    | { status: 'imported'; document: ImportedDocument }
    | { status: 'cancelled' }
    | { status: 'error'; message: string };

/**
 * How large a file may be.
 *
 * Generous for the phone and absurd for the radio: at BLE's few kilobytes a
 * second, even a tenth of this is an afternoon of transfer. The cap is here to
 * stop the extractor running the app out of memory, and the replication policy
 * is what actually decides how far a large document travels.
 */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export async function importDocument(): Promise<ImportResult> {
    const picked = await DocumentPicker.getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
        type: PICKER_TYPES,
    });
    if (picked.canceled || !picked.assets?.length) return { status: 'cancelled' };

    const asset = picked.assets[0] as { name?: string; uri: string; size?: number };
    if (asset.size !== undefined && asset.size > MAX_IMPORT_BYTES) {
        return {
            status: 'error',
            message: `that file is ${Math.round(asset.size / 1024 / 1024)} MB — too large to hold in memory here, and far too large to move over Bluetooth`,
        };
    }

    try {
        const name = asset.name ?? 'document';
        const extracted = extractDocument(await readAssetBytes(asset.uri), name);
        return {
            status: 'imported',
            document: {
                name,
                // Whatever the file said about itself wins, then its own
                // headings, then its name. `parseDocument` already knows that
                // order for text formats, so it is asked rather than re-derived
                // here and left to drift.
                title: extracted.title ?? parseDocument(name, extracted.text).title,
                text: extracted.text,
                format: extracted.format,
                note: sourceNote(extracted.format, name),
            },
        };
    } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * The file, as bytes.
 *
 * Base64 through the bridge rather than `fetch(uri).text()`, which was fine
 * while everything importable was already text and is wrong the moment a PDF
 * arrives: decoding one as UTF-8 mangles every byte the extractor needs before
 * it ever sees them.
 */
async function readAssetBytes(uri: string): Promise<Uint8Array> {
    const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
    });
    return fromBase64(base64);
}

/**
 * What the picker will offer.
 *
 * Both the MIME types and the extensions, because Android content providers
 * are inconsistent about which they report — a .docx routinely arrives as
 * `application/octet-stream`, and a filter of MIME types alone then greys it
 * out in the picker. The format is decided from the bytes afterwards anyway.
 */
const PICKER_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/rtf',
    'text/rtf',
    'text/html',
    'text/markdown',
    'text/plain',
    'text/*',
    'application/octet-stream',
];

const FORMAT_NAME: Record<string, string> = {
    pdf: 'PDF',
    docx: 'Word document',
    odt: 'OpenDocument text',
    rtf: 'RTF',
    html: 'web page',
    markdown: 'Markdown',
    text: 'text file',
};

/**
 * Extraction is a reading of a document, not the document.
 *
 * A PDF's text comes out of where the glyphs were put on the page, so headings,
 * columns and tables arrive approximately. The two formats where that is worth
 * warning about say so; the rest just say what they were, because a Markdown
 * file read as Markdown has nothing to caveat.
 */
function sourceNote(format: string, filename: string): string {
    const kind = FORMAT_NAME[format] ?? 'document';
    return format === 'pdf' || format === 'html'
        ? `Read ${filename} as ${kind} — layout does not always survive, so check how it reads.`
        : `Read ${filename} as ${kind}.`;
}
