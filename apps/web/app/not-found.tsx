// Site-wide 404 in our own markup: Next's built-in 404 uses inline styles the nonce CSP blocks.
// A plain anchor, not next/link: this boundary rides along in every page's payload (JS budget).
import { buttonClass } from '@/components/ui/button.tsx';
import { IconHome } from '@/components/ui/icons.tsx';
import { Logo } from '@/components/ui/logo.tsx';

export default function NotFound() {
  return (
    <main id="main" className="container-narrow stack" style={{ paddingTop: '3rem' }}>
      <Logo size={36} />
      <h1>Page not found</h1>
      <p className="muted">This page does not exist, or the item is no longer listed.</p>
      <p>
        <a className={buttonClass({ variant: 'primary' })} href="/">
          <IconHome />
          Go to Recover
        </a>
      </p>
    </main>
  );
}
