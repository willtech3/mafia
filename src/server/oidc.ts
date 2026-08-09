import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * OAuth resource-server path: when the deployment is fronted by real SSO
 * (ChatGPT Enterprise workspace), requests arrive with a JWT access token.
 * We verify signature/issuer/audience against the IdP's JWKS and use the
 * stable `sub` as the player's identity — seats bind to subjects, so names
 * can't be stolen and reconnects are automatic.
 *
 * Config (all optional — absent means the no-auth token path only):
 *   MAFIA_OIDC_ISSUER    e.g. https://accounts.google.com
 *   MAFIA_OIDC_AUDIENCE  expected aud claim
 *   MAFIA_OIDC_JWKS_URL  override; default {issuer}/.well-known/jwks.json is
 *                        NOT assumed — for most IdPs use discovery manually.
 *
 * What this deliberately does not include: an OAuth *authorization server*.
 * ChatGPT's OAuth connector flow needs AS metadata + client registration,
 * which must point at the workspace IdP — a per-deployment decision. See
 * DECISIONS.md.
 */

export interface OidcIdentity {
  subject: string;
  name: string | undefined;
}

export interface OidcVerifier {
  verify(token: string): Promise<OidcIdentity | null>;
}

/** JWTs have three dot-separated base64url segments; player tokens have our CODE.pid.sig shape. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)) && token.startsWith('eyJ');
}

export function oidcFromEnv(): OidcVerifier | null {
  const issuer = process.env['MAFIA_OIDC_ISSUER'];
  if (!issuer) return null;
  const jwksUrl = process.env['MAFIA_OIDC_JWKS_URL'] ?? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const audience = process.env['MAFIA_OIDC_AUDIENCE'];
  return makeVerifier(createRemoteJWKSet(new URL(jwksUrl)), issuer, audience);
}

/** Exposed for tests (local JWK sets) and future IdP variants. */
export function makeVerifier(getKey: JWTVerifyGetKey, issuer: string, audience?: string): OidcVerifier {
  return {
    async verify(token: string): Promise<OidcIdentity | null> {
      try {
        const { payload } = await jwtVerify(token, getKey, {
          issuer,
          ...(audience ? { audience } : {}),
        });
        if (!payload.sub) return null;
        const name =
          (typeof payload['name'] === 'string' && payload['name']) ||
          (typeof payload['email'] === 'string' && payload['email'].split('@')[0]) ||
          undefined;
        return { subject: payload.sub, name };
      } catch {
        return null; // bad/expired/foreign token -> fall through to other identity paths
      }
    },
  };
}
