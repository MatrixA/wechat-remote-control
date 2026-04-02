export interface Config {
    workingDirectory: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
