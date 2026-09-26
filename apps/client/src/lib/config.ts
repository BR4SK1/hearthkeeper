/**
 * GM base URL for the campfire client. Empty string means same-origin
 * relative /v1/... — useful when a reverse proxy routes requests to the GM
 * service. In development set NEXT_PUBLIC_GM_BASE_URL to the GM origin.
 */
export const GM_BASE_URL: string = process.env.NEXT_PUBLIC_GM_BASE_URL ?? "";
