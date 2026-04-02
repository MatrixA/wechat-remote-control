import type { PendingPermission } from './session.js';
export type OnPermissionTimeout = () => void;
export declare function createPermissionBroker(onTimeout?: OnPermissionTimeout): {
    createPending: (accountId: string, toolName: string, toolInput: string) => Promise<boolean>;
    resolvePermission: (accountId: string, allowed: boolean) => boolean;
    rejectPending: (accountId: string) => boolean;
    isTimedOut: (accountId: string) => boolean;
    clearTimedOut: (accountId: string) => void;
    getPending: (accountId: string) => PendingPermission | undefined;
    formatPendingMessage: (perm: PendingPermission) => string;
};
