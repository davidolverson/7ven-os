"use client";

import { useRef, useState } from "react";

type FieldErrors = Record<string, string[] | undefined>;

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; applicationId?: string }
  | { kind: "error"; message: string };

function firstError(errors: FieldErrors, field: string) {
  return errors[field]?.[0];
}

export function ApplicationForm() {
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const idempotencyKey = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmission({ kind: "submitting" });
    setFieldErrors({});

    const formData = new FormData(event.currentTarget);
    const portfolioText = String(formData.get("portfolioUrls") ?? "");

    const payload = {
      displayName: String(formData.get("displayName") ?? ""),
      email: String(formData.get("email") ?? ""),
      requestedTrack: String(formData.get("requestedTrack") ?? ""),
      gameTitle: String(formData.get("gameTitle") ?? "") || undefined,
      goals: String(formData.get("goals") ?? ""),
      experience: String(formData.get("experience") ?? ""),
      portfolioUrls: portfolioText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      companyWebsite: String(formData.get("companyWebsite") ?? ""),
    };

    idempotencyKey.current ??= crypto.randomUUID();

    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify(payload),
      });

      const result = (await response.json()) as {
        ok?: boolean;
        applicationId?: string;
        error?: { message?: string; fields?: FieldErrors };
      };

      if (!response.ok) {
        if (response.status === 422 && result.error?.fields) {
          setFieldErrors(result.error.fields);
        }
        setSubmission({
          kind: "error",
          message: result.error?.message ?? "The application could not be submitted.",
        });
        return;
      }

      setSubmission({ kind: "success", applicationId: result.applicationId });
      idempotencyKey.current = null;
      formRef.current?.reset();
    } catch {
      setSubmission({
        kind: "error",
        message: "Network error. Your retry will reuse the same submission key to avoid duplicates.",
      });
    }
  }

  if (submission.kind === "success") {
    return (
      <section className="card stack" aria-live="polite">
        <p className="eyebrow">Submitted</p>
        <h2>Application received.</h2>
        <p className="muted">
          This confirms intake only. It is not an acceptance, employment offer, roster guarantee, or promise of compensation.
        </p>
        {submission.applicationId ? <p className="muted">Reference: {submission.applicationId}</p> : null}
        <button className="button" type="button" onClick={() => setSubmission({ kind: "idle" })}>
          Submit another application
        </button>
      </section>
    );
  }

  return (
    <form ref={formRef} className="card stack" onSubmit={onSubmit} noValidate>
      <div>
        <p className="eyebrow">Application</p>
        <h2>Show us what you are building toward.</h2>
        <p className="muted form-intro">
          A real opportunity to be evaluated does not guarantee membership. Decisions remain human-reviewed.
        </p>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="displayName">Display name</label>
          <input
            className="input"
            id="displayName"
            name="displayName"
            autoComplete="name"
            maxLength={80}
            aria-invalid={Boolean(firstError(fieldErrors, "displayName"))}
            aria-describedby={firstError(fieldErrors, "displayName") ? "displayName-error" : undefined}
            required
          />
          {firstError(fieldErrors, "displayName") ? (
            <span id="displayName-error" className="field-error">{firstError(fieldErrors, "displayName")}</span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            className="input"
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            aria-invalid={Boolean(firstError(fieldErrors, "email"))}
            aria-describedby={firstError(fieldErrors, "email") ? "email-error" : undefined}
            required
          />
          {firstError(fieldErrors, "email") ? (
            <span id="email-error" className="field-error">{firstError(fieldErrors, "email")}</span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="requestedTrack">Track</label>
          <select
            className="select"
            id="requestedTrack"
            name="requestedTrack"
            defaultValue=""
            aria-invalid={Boolean(firstError(fieldErrors, "requestedTrack"))}
            required
          >
            <option value="" disabled>Select a track</option>
            <option value="competitive">Competitive</option>
            <option value="creator">Creator</option>
            <option value="builder">Builder</option>
            <option value="community">Community</option>
            <option value="leadership">Leadership</option>
          </select>
          {firstError(fieldErrors, "requestedTrack") ? (
            <span className="field-error">{firstError(fieldErrors, "requestedTrack")}</span>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="gameTitle">Primary game/title (optional)</label>
          <input className="input" id="gameTitle" name="gameTitle" maxLength={80} autoComplete="off" />
        </div>

        <div className="field field-span-2">
          <label htmlFor="goals">What are you trying to become or accomplish?</label>
          <textarea
            className="textarea"
            id="goals"
            name="goals"
            minLength={20}
            maxLength={2000}
            aria-invalid={Boolean(firstError(fieldErrors, "goals"))}
            required
          />
          {firstError(fieldErrors, "goals") ? <span className="field-error">{firstError(fieldErrors, "goals")}</span> : null}
        </div>

        <div className="field field-span-2">
          <label htmlFor="experience">What have you already done?</label>
          <textarea
            className="textarea"
            id="experience"
            name="experience"
            minLength={20}
            maxLength={4000}
            aria-invalid={Boolean(firstError(fieldErrors, "experience"))}
            required
          />
          {firstError(fieldErrors, "experience") ? (
            <span className="field-error">{firstError(fieldErrors, "experience")}</span>
          ) : null}
        </div>

        <div className="field field-span-2">
          <label htmlFor="portfolioUrls">Portfolio / clips / profiles (one URL per line, up to 5)</label>
          <textarea
            className="textarea"
            id="portfolioUrls"
            name="portfolioUrls"
            inputMode="url"
            autoComplete="off"
            aria-invalid={Boolean(firstError(fieldErrors, "portfolioUrls"))}
          />
          {firstError(fieldErrors, "portfolioUrls") ? (
            <span className="field-error">{firstError(fieldErrors, "portfolioUrls")}</span>
          ) : null}
        </div>
      </div>

      <div className="visually-hidden" aria-hidden="true">
        <label htmlFor="companyWebsite">Company website</label>
        <input id="companyWebsite" name="companyWebsite" tabIndex={-1} autoComplete="off" />
      </div>

      {submission.kind === "error" ? (
        <div className="form-error" role="alert">{submission.message}</div>
      ) : null}

      <button className="button button-primary" type="submit" disabled={submission.kind === "submitting"}>
        {submission.kind === "submitting" ? "Submitting…" : "Submit application"}
      </button>
    </form>
  );
}
