/** Client-safe constants; do not import the database into client components. */
export const SERVICE_SCOPES = ["campaigns:read", "campaigns:write", "campaigns:activate"] as const;
/** Days a new key may live. */
export const SERVICE_KEY_LIFETIMES = [30, 60, 90, 180, 365] as const;
