import { z } from "zod";

const breakGlassPrincipalSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === "" ||
      /^user:[^\s:]+$/.test(value) ||
      /^email:[^\s@]+@[^\s@]+$/.test(value),
    "BREAK_GLASS_PRINCIPAL must be blank, user:<auth-user-id>, or email:<exact-email>.",
  );

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  AUTH_DATABASE_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  PRIVACY_HASH_SECRET: z.string().min(32),
  ALLOW_PUBLIC_SIGNUP: z.enum(["true", "false"]).default("false"),
  APPLICATION_INTAKE_ENABLED: z.enum(["true", "false"]).default("false"),
  BREAK_GLASS_PRINCIPAL: breakGlassPrincipalSchema.default(""),
});

const parsed = serverEnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid server environment: ${details}`);
}

export const env = {
  ...parsed.data,
  allowPublicSignup: parsed.data.ALLOW_PUBLIC_SIGNUP === "true",
  applicationIntakeEnabled: parsed.data.APPLICATION_INTAKE_ENABLED === "true",
};
