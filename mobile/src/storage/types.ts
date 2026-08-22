export interface StoredChunk {
    docId: number;
    docKey: number;
    seq: number;
    title: string;
    section: string;
    source: string;
    text: string;
}

export interface CatalogStats {
    documents: number;
    chunks: number;
    bytes: number;
}
