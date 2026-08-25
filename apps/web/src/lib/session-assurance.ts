export interface SessionAssurance {
  twoFactorEnabled: boolean;
  strongAuthAt: Date | null;
  strongAuthVerified: boolean;
}

export function parseStrongAuthAt(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return null;

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function evaluateSessionAssurance(
  user: { twoFactorEnabled?: boolean | null | undefined },
  session: { strongAuthAt?: unknown },
): SessionAssurance {
  const twoFactorEnabled = user.twoFactorEnabled === true;
  const strongAuthAt = parseStrongAuthAt(session.strongAuthAt);

  return {
    twoFactorEnabled,
    strongAuthAt,
    strongAuthVerified: twoFactorEnabled && strongAuthAt !== null,
  };
}
