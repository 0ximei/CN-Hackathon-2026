export type Provenance = 'seed' | 'local' | 'mesh';

export interface StoredChunk {
    docId: number;
    docKey: number;
    seq: number;
    title: string;
    section: string;
    source: string;
    text: string;
    provenance: Provenance;
}

export interface CatalogStats {
    documents: number;
    chunks: number;
    bytes: number;
}

export interface DocSummary {
    docKey: number;
    title: string;
    source: string;
    provenance: Provenance;
    chunks: number;
    bytes: number;
}
