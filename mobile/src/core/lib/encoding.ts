/**
 * Turning other people's bytes into characters.
 *
 * Every importer needs some of this and they need to agree, because the same
 * apostrophe arrives as one byte from a PDF, as three from a UTF-8 note and as
 * two from a Windows text file, and a document that renders three different
 * apostrophes does not match a search for any of them.
 */

/**
 * Bytes as characters, one for one.
 *
 * Latin-1 is the only decoding where a string index is still a byte offset,
 * which is what makes it safe to locate a keyword in the text of a binary
 * container and then slice the *bytes* at that position. Chunked because
 * `fromCharCode` takes its arguments on the stack, and a megabyte of them
 * overflows it.
 */
export function latin1(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    if (bytes.length <= CHUNK) return String.fromCharCode(...bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return out;
}

/**
 * The 0x80–0x9F block, where WinAnsi (and RTF's default code page) part company
 * with Latin-1.
 *
 * Everything outside it is Latin-1, which is the identity on code points. This
 * block is where the curly quotes, the dashes and the ellipsis live, so treating
 * it as Latin-1 turns every apostrophe in a document into a control character.
 *
 * Five of the thirty-two positions are undefined and are held open with
 * U+FFFD rather than left out. Closing the gaps would shift every character
 * after 0x8C by one or more places — silently, into another real character, so
 * an apostrophe would come out as an en dash and nothing downstream could tell.
 */
const WIN_ANSI_HIGH =
    '\u20AC\uFFFD\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\uFFFD' +
    '\u017D\uFFFD\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A' +
    '\u0153\uFFFD\u017E\u0178';

export function winAnsiChar(byte: number): string {
    if (byte >= 0x80 && byte <= 0x9f) {
        const ch = WIN_ANSI_HIGH[byte - 0x80];
        return ch === '\uFFFD' ? '' : (ch ?? '');
    }
    // Control characters that are not whitespace carry no text.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return '';
    return String.fromCharCode(byte);
}

/**
 * A text file, whatever it was encoded as.
 *
 * Byte-order marks are honoured where present and UTF-8 is assumed where they
 * are not, which is the right guess for anything written this decade. The
 * `binary` flag is the important part of the return: it is how the caller tells
 * a text file in an encoding we mishandled from a file that was never text, and
 * only the second one should be refused.
 */
export function decodeTextBytes(bytes: Uint8Array): { text: string; binary: boolean } {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { text: utf16(bytes.subarray(2), true), binary: false };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { text: utf16(bytes.subarray(2), false), binary: false };
    }

    const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? bytes.subarray(3)
        : bytes;
    const text = new TextDecoder().decode(body);

    return { text, binary: looksBinary(text) };
}

function utf16(bytes: Uint8Array, littleEndian: boolean): string {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(
            littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1],
        );
    }
    return out;
}

/**
 * Whether a decode produced text or wreckage.
 *
 * `TextDecoder` never fails — it substitutes U+FFFD and carries on — so a JPEG
 * decodes to a string just as happily as a note does. Nulls and replacement
 * characters are what separate them, measured as a share so that one stray
 * byte in a long document does not condemn it.
 */
function looksBinary(text: string): boolean {
    const sample = text.slice(0, 4096);
    if (!sample) return false;
    let bad = 0;
    for (const ch of sample) {
        const code = ch.codePointAt(0)!;
        if (code === 0xfffd || code === 0) bad++;
        else if (code < 0x09 || (code > 0x0d && code < 0x20)) bad++;
    }
    return bad / sample.length > 0.02;
}
