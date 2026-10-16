export declare const VARIANTS: readonly string[];
export declare function buildBundles(): Promise<Record<string, string>>;
export declare function renderModule(bundles: Record<string, string>): string;
