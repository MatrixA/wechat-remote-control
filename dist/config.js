import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const CONFIG_DIR = join(homedir(), ".wechat-bridge");
const CONFIG_PATH = join(CONFIG_DIR, "config.env");
const DEFAULT_CONFIG = {
    workingDirectory: process.cwd(),
};
function ensureConfigDir() {
    mkdirSync(CONFIG_DIR, { recursive: true });
}
function parseConfigFile(content) {
    const config = { ...DEFAULT_CONFIG };
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1)
            continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        switch (key) {
            case "workingDirectory":
                config.workingDirectory = value;
                break;
            case "model":
                config.model = value;
                break;
            case "permissionMode":
                if (value === "default" ||
                    value === "acceptEdits" ||
                    value === "plan" ||
                    value === "auto") {
                    config.permissionMode = value;
                }
                break;
        }
    }
    return config;
}
export function loadConfig() {
    try {
        const content = readFileSync(CONFIG_PATH, "utf-8");
        return parseConfigFile(content);
    }
    catch {
        // File does not exist yet — return defaults
        return { ...DEFAULT_CONFIG };
    }
}
export function saveConfig(config) {
    ensureConfigDir();
    const lines = [];
    lines.push(`workingDirectory=${config.workingDirectory}`);
    if (config.model) {
        lines.push(`model=${config.model}`);
    }
    if (config.permissionMode) {
        lines.push(`permissionMode=${config.permissionMode}`);
    }
    writeFileSync(CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
    if (process.platform !== 'win32') {
        chmodSync(CONFIG_PATH, 0o600);
    }
}
