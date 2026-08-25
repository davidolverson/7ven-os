import { betterAuth } from "better-auth";
import { admin, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
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

const authOrigin = new URL(env.BETTER_AUTH_URL).origin;
const rpID = new URL(env.BETTER_AUTH_URL).hostname;
const strongAuthSessionPaths = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export const auth = betterAuth({
  appName: "Org OS",
  database: authPool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  telemetry: { enabled: false },
  disabledPaths: [
    // Better Auth 1.7 does not apply its TOTP challenge to passkey sign-in by default.
    // Keep passkey authentication fail-closed until Org OS can mark that session with equivalent assurance.
    "/sign-in/passkey",
  ],
  advanced: {
    database: {
      joins: true,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    additionalFields: {
      // Server-owned session assurance. Account-level 2FA enrollment is not sufficient for privileged writes.
      strongAuthAt: {
        type: "date",
        required: false,
        input: false,
        returned: true,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => {
          if (!strongAuthSessionPaths.has(ctx?.path ?? "")) {
            return { data: session };
          }

          return {
            data: {
              ...session,
              strongAuthAt: new Date(),
            },
          };
        },
      },
    },
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
  plugins: [
    // Better Auth admin is identity administration only. Org authority remains in app.role_assignment.
    admin(),
    twoFactor({
      issuer: "Org OS",
      skipVerificationOnEnable: false,
    }),
    passkey({
      rpID,
      rpName: "Org OS",
      origin: authOrigin,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    }),
  ],
});
