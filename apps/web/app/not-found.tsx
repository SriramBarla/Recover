// Site-wide 404 in our own markup: Next's built-in 404 uses inline styles the nonce CSP blocks.
import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="container-narrow stack" style={{ paddingTop: '3rem' }}>
      <h1>Page not found</h1>
      <p className="muted">This page does not exist, or the item is no longer listed.</p>
      <p>
        <Link className="btn btn-primary" href="/">
          Go to Recover
        </Link>
      </p>
    </main>
  );
}
