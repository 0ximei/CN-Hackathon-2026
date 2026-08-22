declare module 'expo-document-picker' {
    export type DocumentPickerAsset = {
        name?: string;
        uri: string;
        mimeType?: string | null;
        size?: number | null;
    };

    export function getDocumentAsync(options?: {
        multiple?: boolean;
        copyToCacheDirectory?: boolean;
        type?: string[];
    }): Promise<{ canceled: boolean; assets?: DocumentPickerAsset[] }>;
}
