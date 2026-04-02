import type { CommandContext, CommandResult } from './router.js';
/** 清除缓存，用于 /skills 命令强制刷新 */
export declare function invalidateSkillCache(): void;
export declare function handleHelp(_args: string): CommandResult;
export declare function handleClear(ctx: CommandContext): CommandResult;
export declare function handleCwd(ctx: CommandContext, args: string): CommandResult;
export declare function handleModel(ctx: CommandContext, args: string): CommandResult;
export declare function handlePermission(ctx: CommandContext, args: string): CommandResult;
export declare function handleStatus(ctx: CommandContext): CommandResult;
export declare function handleSkills(args: string): CommandResult;
export declare function handleHistory(ctx: CommandContext, args: string): CommandResult;
/** 完全重置会话（包括工作目录等设置） */
export declare function handleReset(ctx: CommandContext): CommandResult;
/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export declare function handleCompact(ctx: CommandContext): CommandResult;
/** 撤销最近 N 条对话 */
export declare function handleUndo(ctx: CommandContext, args: string): CommandResult;
/** 查看版本信息 */
export declare function handleVersion(): CommandResult;
export declare function handleUnknown(cmd: string, args: string): CommandResult;
