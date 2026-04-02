export interface SkillInfo {
    name: string;
    description: string;
    path: string;
}
/**
 * Scan all known skill directories for installed Claude Code skills.
 *
 * Locations scanned:
 * 1. ~/.claude/skills/ (each subdirectory)
 * 2. ~/.claude/plugins/cache/{plugin}/skills/ (each subdirectory)
 * 3. ~/.claude/plugins/cache/{plugin}/superpowers/skills/ (each subdirectory)
 */
export declare function scanAllSkills(): SkillInfo[];
/**
 * Format a list of skills into a readable string for display.
 */
export declare function formatSkillList(skills: SkillInfo[]): string;
/**
 * Find a skill by name (case-insensitive match).
 */
export declare function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined;
