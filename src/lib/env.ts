function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  get issuer() {
    return required("OIDC_ISSUER").replace(/\/$/, "");
  },
  get clientId() {
    return required("OIDC_CLIENT_ID");
  },
  get clientSecret() {
    return required("OIDC_CLIENT_SECRET");
  },
  get appUrl() {
    return required("APP_URL").replace(/\/$/, "");
  },
  get sessionSecret() {
    const secret = required("SESSION_SECRET");
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return secret;
  },
};
