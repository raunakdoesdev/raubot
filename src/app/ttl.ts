/** Expiry choices for a secret, in seconds; 0 keeps it until removed. Shared by the server and the web app. */
export const TTLS = [["Keep until removed", 0], ["1 hour", 3600], ["1 day", 86_400], ["7 days", 604_800], ["30 days", 2_592_000]] as const;
