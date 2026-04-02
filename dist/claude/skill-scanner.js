import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';
/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Only extracts `name` and `description` fields.
 */
function parseSkillMd(filePath) {
    try {
        const content = readFileSync(filePath, 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match)
            return null;
        const frontmatter = match[1];
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        if (!nameMatch)
            return null;
        return {
            name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
            description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
        };
    }
    catch {
        logger.warn(`Failed to read SKILL.md: ${filePath}`);
        return null;
    }
}
/**
 * Scan a directory for SKILL.md files, reading skill info from each.
 */
function scanDirectory(baseDir, depth = 2) {
    const skills = [];
    if (!existsSync(baseDir))
        return skills;
    let entries;
    try {
        entries = readdirSync(baseDir, { withFileTypes: true });
    }
    catch {
        return skills;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const fullPath = join(baseDir, entry.name);
        if (depth > 1) {
            // Recurse one level deeper
            skills.push(...scanDirectory(fullPath, depth - 1));
        }
        const skillFile = join(fullPath, 'SKILL.md');
        if (existsSync(skillFile)) {
            const info = parseSkillMd(skillFile);
            if (info) {
                skills.push({ ...info, path: fullPath });
            }
        }
    }
    return skills;
}
/**
 * Scan all known skill directories for installed Claude Code skills.
 *
 * Locations scanned:
 * 1. ~/.claude/skills/ (each subdirectory)
 * 2. ~/.claude/plugins/cache/{plugin}/skills/ (each subdirectory)
 * 3. ~/.claude/plugins/cache/{plugin}/superpowers/skills/ (each subdirectory)
 */
export function scanAllSkills() {
    const home = homedir();
    const claudeDir = join(home, '.claude');
    const skills = [];
    const seen = new Set();
    // 1. ~/.claude/skills/*/
    const userSkillsDir = join(claudeDir, 'skills');
    for (const skill of scanDirectory(userSkillsDir, 1)) {
        if (!seen.has(skill.name)) {
            seen.add(skill.name);
            skills.push(skill);
        }
    }
    // 2. ~/.claude/plugins/cache/*/skills/*/
    const pluginsCacheDir = join(claudeDir, 'plugins', 'cache');
    if (existsSync(pluginsCacheDir)) {
        let cacheEntries;
        try {
            cacheEntries = readdirSync(pluginsCacheDir, { withFileTypes: true });
        }
        catch {
            cacheEntries = [];
        }
        for (const cacheEntry of cacheEntries) {
            if (!cacheEntry.isDirectory())
                continue;
            const cacheDir = join(pluginsCacheDir, cacheEntry.name);
            // Regular skills
            const pluginSkillsDir = join(cacheDir, 'skills');
            for (const skill of scanDirectory(pluginSkillsDir, 1)) {
                if (!seen.has(skill.name)) {
                    seen.add(skill.name);
                    skills.push(skill);
                }
            }
            // Superpowers skills
            const superpowersSkillsDir = join(cacheDir, 'superpowers', 'skills');
            for (const skill of scanDirectory(superpowersSkillsDir, 1)) {
                if (!seen.has(skill.name)) {
                    seen.add(skill.name);
                    skills.push(skill);
                }
            }
        }
    }
    logger.info(`Scanned ${skills.length} skills`);
    return skills;
}
/**
 * Format a list of skills into a readable string for display.
 */
export function formatSkillList(skills) {
    if (skills.length === 0) {
        return 'No skills found.';
    }
    const lines = skills.map((s, i) => {
        const desc = s.description ? ` - ${s.description}` : '';
        return `  ${i + 1}. ${s.name}${desc}`;
    });
    return `Available skills (${skills.length}):\n${lines.join('\n')}`;
}
/**
 * Find a skill by name (case-insensitive match).
 */
export function findSkill(skills, name) {
    const lower = name.toLowerCase();
    return skills.find((s) => s.name.toLowerCase() === lower || s.name.toLowerCase().replace(/\s+/g, '-') === lower);
}
