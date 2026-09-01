import { OAuth2Client } from "google-auth-library";

export function createAuthenticator(clientId) {
  const client = new OAuth2Client(clientId);
  return async function authenticate(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new Error("Sign in with Google to continue");
    const ticket = await client.verifyIdToken({ idToken: token, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email_verified) throw new Error("A verified Google account is required");
    return { id: payload.sub, email: payload.email || "", name: payload.name || "Builder" };
  };
}
