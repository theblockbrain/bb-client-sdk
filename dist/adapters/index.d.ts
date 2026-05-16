export { I as IdentityAdapter } from '../identity-DyKDSltP.js';

interface StorageAdapter {
    get<T = unknown>(key: string): Promise<T | null>;
    set<T = unknown>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
}

export type { StorageAdapter };
