/**
 * Telegram credentials, inlined at build time by `vite.config.ts`. Values, not
 * lookups.
 */
export const API_ID = Number(import.meta.env.CHAFF_API_ID ?? 0);

export const API_HASH: string = import.meta.env.CHAFF_API_HASH ?? '';

// Not a secret: a public number used to prefill the login form. Kept as a
// constant because SvelteKit owns `import.meta.env.CHAFF_*` and overrides any
// `define` for that prefix with an empty string.
export const PHONE = '+2349069170098';

/** False when the build had no credentials, so the UI can say so. */
export const credentialsPresent = API_ID > 0 && API_HASH.length > 0;
