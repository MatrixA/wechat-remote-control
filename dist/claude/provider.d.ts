export interface QueryOptions {
    prompt: string;
    cwd: string;
    resume?: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "plan";
    images?: Array<{
        type: "image";
        source: {
            type: "base64";
            media_type: string;
            data: string;
        };
    }>;
    onPermissionRequest?: (toolName: string, toolInput: string) => Promise<boolean>;
}
export interface QueryResult {
    text: string;
    sessionId: string;
    error?: string;
}
export declare function claudeQuery(options: QueryOptions): Promise<QueryResult>;
