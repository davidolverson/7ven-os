import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { env } from "@/lib/env";

declare global {
  var __orgAuthPool: Pool | undefined;
}

const authPool =
  globalThis.__orgAuthPool ??
  new Pool({
    connectionString: env.AUTH_DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: `org-os-auth-${env.APP_ENV}`,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__orgAuthPool = authPool;
}

export const auth = betterAuth({
  database: authPool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  telemetry: { enabled: false },
  advanced: {
    database: {
      joins: true,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: !env.allowPublicSignup,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
  },
  trustedOrigins: [env.NEXT_PUBLIC_APP_URL],
});
