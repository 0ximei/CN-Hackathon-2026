import { describe, expect, it } from 'vitest';

import { parseDocument } from './chunk';

/**
 * Where a document's name comes from.
 *
 * Two callers, two different truths. A file picked off disk has no stated name
 * — only a filename and whatever its markdown claims — so the heading wins. Text
 * typed into the composer does have one, and it has to survive the trip: the
 * name travels with the metadata to every phone in range, and `forget` clears
 * only the node it is run on.
 */
describe('parseDocument titling', () => {
    const BODY = '# Snakebite\n\nKeep the limb still and below the heart.';

    it('takes the title from a markdown heading when nobody stated one', () => {
        expect(parseDocument('uploaded-0.txt', BODY).title).toBe('Snakebite');
    });

    it('falls back to the filename, extension stripped', () => {
        expect(parseDocument('snakebite.md', 'Keep the limb still.').title).toBe('snakebite');
    });

    it('keeps the stated title even when the body carries a heading', () => {
        expect(parseDocument('note.md', BODY, 'Kali crossing').title).toBe('Kali crossing');
    });

    it('leaves headings out of the body either way', () => {
        const stated = parseDocument('note.md', BODY, 'Kali crossing');
        const inferred = parseDocument('note.md', BODY);
        expect(stated.chunks.map((c) => c.text)).toEqual(inferred.chunks.map((c) => c.text));
        expect(stated.chunks[0].text).not.toContain('#');
    });
});
