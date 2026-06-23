// src/utils/jwt.ts
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const b64 = parts[1];
  if (!b64) return null;
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - padded.length % 4);
    const decoded = atob(padded + padding);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
function subFromAccessToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}

export {
  subFromAccessToken
};
//# sourceMappingURL=chunk-MUVMG2CU.js.map