/** Minimal CSV parser — comma-separated, double-quote escaping, header row required.
 * No dependency: the file is small enough that a library would cost more than it saves. */
export declare function parseCsv(text: string): Record<string, string>[];
