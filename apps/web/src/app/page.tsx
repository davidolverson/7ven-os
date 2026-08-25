import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content" className="page-wrap" style={{ padding: "clamp(28px, 7vw, 88px) 18px" }}>
      <p className="eyebrow">Production foundation</p>
      <h1 style={{ maxWidth: "15ch" }}>Opportunity should be earned, not gatekept by clout.</h1>
      <p className="muted" style={{ maxWidth: "62ch", marginTop: 18, fontSize: "1.05rem" }}>
        Org OS is the internal operating layer for talent discovery, development, competition, creators,
        member services, safety, governance, and permanent career history. Final organization branding is
        intentionally not locked yet.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 26 }}>
        <Link className="button button-primary" href="/apply">
          Application status
        </Link>
        <Link className="button" href="/sign-in">
          Member sign in
        </Link>
      </div>

      <section className="grid grid-3" aria-label="Operating principles" style={{ marginTop: 44 }}>
        <article className="card">
          <p className="eyebrow">Opportunity</p>
          <h2>Anyone can earn a real chance to be seen.</h2>
          <p className="muted" style={{ marginTop: 10 }}>Existing fame is not the universal admission gate.</p>
        </article>
        <article className="card">
          <p className="eyebrow">Growth</p>
          <h2>The Grind is evidence of development, not a social-credit score.</h2>
          <p className="muted" style={{ marginTop: 10 }}>No follower farming, message spam, or hidden mega-score.</p>
        </article>
        <article className="card">
          <p className="eyebrow">Stewardship</p>
          <h2>Leave better than you arrived.</h2>
          <p className="muted" style={{ marginTop: 10 }}>Skills, history, opportunities, and verified accomplishments should remain useful after departure.</p>
        </article>
      </section>
    </main>
  );
}
