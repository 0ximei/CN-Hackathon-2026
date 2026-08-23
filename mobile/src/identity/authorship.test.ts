import { describe, expect, it } from 'vitest';

import { keysFromSeed, nodeIdFor, sign } from './keys';
import {
    contentMatches,
    hashDocument,
    manifestBytes,
    verifyAuthorship,
    type DocManifest,
} from './authorship';

const CHUNKS = [
    'Apply firm direct pressure to the wound with a clean cloth.',
    'If bleeding does not stop, apply a tourniquet high and tight above the wound.',
];

function author(seed = 7) {
    const keys = keysFromSeed(new Uint8Array(32).fill(seed));
    return { keys, id: nodeIdFor(keys.publicKey) };
}

function manifest(authorId: number, over = CHUNKS): DocManifest {
    return {
        docKey: 0xdeadbeef,
        docHash: hashDocument('Severe Bleeding', over),
        title: 'Severe Bleeding',
        source: 'bleeding.md',
        chunkCount: over.length,
        bytes: over.join('\n').length,
        createdAtSec: 1_700_000_000,
        authorId,
    };
}

describe('document authorship', () => {
    it('verifies a document its author signed', () => {
        const a = author();
        const m = manifest(a.id);
        const sig = sign(manifestBytes(m), a.keys.secretKey);
        expect(verifyAuthorship(m, sig, a.keys.publicKey)).toBe('verified');
    });

    it('rejects a signature stapled to somebody else’s author id', () => {
        // The whole point of the key/id binding. A forger signs their own
        // manifest perfectly well; they cannot produce a key that hashes to
        // the id they are trying to impersonate.
        const victim = author(1);
        const forger = author(2);
        const m = manifest(victim.id);
        const sig = sign(manifestBytes(m), forger.keys.secretKey);
        expect(verifyAuthorship(m, sig, forger.keys.publicKey)).toBe('forged');
    });

    it('rejects a relay that edited the title', () => {
        const a = author();
        const m = manifest(a.id);
        const sig = sign(manifestBytes(m), a.keys.secretKey);
        expect(verifyAuthorship({ ...m, title: 'Mild Bleeding' }, sig, a.keys.publicKey)).toBe('forged');
    });

    it('rejects a relay that edited the filename', () => {
        const a = author();
        const m = manifest(a.id);
        const sig = sign(manifestBytes(m), a.keys.secretKey);
        expect(verifyAuthorship({ ...m, source: 'evil.md' }, sig, a.keys.publicKey)).toBe('forged');
    });

    it('rejects a relay that swapped the content hash', () => {
        const a = author();
        const m = manifest(a.id);
        const sig = sign(manifestBytes(m), a.keys.secretKey);
        const swapped = { ...m, docHash: hashDocument('Severe Bleeding', ['Do nothing and wait.']) };
        expect(verifyAuthorship(swapped, sig, a.keys.publicKey)).toBe('forged');
    });

    it('cannot be fooled by moving a character across a field boundary', () => {
        // Without length prefixes, title "ab" + source "c" and title "a" +
        // source "bc" encode to the same bytes, so one signature covers both.
        const a = author();
        const one = { ...manifest(a.id), title: 'ab', source: 'c' };
        const two = { ...manifest(a.id), title: 'a', source: 'bc' };
        expect(manifestBytes(one)).not.toEqual(manifestBytes(two));
        const sig = sign(manifestBytes(one), a.keys.secretKey);
        expect(verifyAuthorship(two, sig, a.keys.publicKey)).toBe('forged');
    });

    it('calls a document with nothing attached unsigned, not forged', () => {
        // The built-in corpus and anything from an older build. "Unsigned" is
        // an honest absence; "forged" is an accusation.
        expect(verifyAuthorship(manifest(author().id), undefined, undefined)).toBe('unsigned');
    });

    it('treats half an attestation as forged', () => {
        const a = author();
        const m = manifest(a.id);
        const sig = sign(manifestBytes(m), a.keys.secretKey);
        expect(verifyAuthorship(m, sig, undefined)).toBe('forged');
        expect(verifyAuthorship(m, undefined, a.keys.publicKey)).toBe('forged');
        expect(verifyAuthorship(m, sig.subarray(0, 32), a.keys.publicKey)).toBe('forged');
    });

    it('checks the stored bytes against the hash that was signed', () => {
        const hash = hashDocument('Severe Bleeding', CHUNKS);
        expect(contentMatches(hash, 'Severe Bleeding', CHUNKS)).toBe(true);
        expect(contentMatches(hash, 'Severe Bleeding', [CHUNKS[0], 'Ignore it.'])).toBe(false);
        expect(contentMatches(hash, 'Severe Bleeding', [CHUNKS[1], CHUNKS[0]])).toBe(false);
        expect(contentMatches(hash, 'Mild Bleeding', CHUNKS)).toBe(false);
    });
});
