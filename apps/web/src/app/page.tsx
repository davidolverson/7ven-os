import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content" className="landing-page">
      <p className="eyebrow">Production foundation</p>
      <h1 className="landing-title">Opportunity should be earned, not gatekept by clout.</h1>
      <p className="muted landing-copy">
        Org OS is the internal operating layer for talent discovery, development, competition, creators,
        member services, safety, governance, and permanent career history. Final organization branding is
        intentionally not locked yet.
      </p>
      <div className="action-row">
        <Link className="button button-primary" href="/apply">
          Application status
        </Link>
        <Link className="button" href="/sign-in">
          Member sign in
        </Link>
      </div>

      <section className="grid grid-3 principle-grid" aria-label="Operating principles">
        <article className="card">
          <p className="eyebrow">Opportunity</p>
          <h2>Anyone can earn a real chance to be seen.</h2>
          <p className="muted card-copy">Existing fame is not the universal admission gate.</p>
        </article>
        <article className="card">
          <p className="eyebrow">Growth</p>
          <h2>The Grind is evidence of development, not a social-credit score.</h2>
          <p className="muted card-copy">No follower farming, message spam, or hidden mega-score.</p>
        </article>
        <article className="card">
          <p className="eyebrow">Stewardship</p>
          <h2>Leave better than you arrived.</h2>
          <p className="muted card-copy">Skills, history, opportunities, and verified accomplishments should remain useful after departure.</p>
        </article>
      </section>
    </main>
  );
}
