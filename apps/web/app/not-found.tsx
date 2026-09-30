// Site-wide 404 in our own markup: Next's built-in 404 uses inline styles the nonce CSP blocks.
import { LinkButton } from '@/components/ui/button.tsx';
import { IconHome } from '@/components/ui/icons.tsx';
import { Logo } from '@/components/ui/logo.tsx';

export default function NotFound() {
  return (
    <main id="main" className="container-narrow stack" style={{ paddingTop: '3rem' }}>
      <Logo size={36} />
      <h1>Page not found</h1>
      <p className="muted">This page does not exist, or the item is no longer listed.</p>
      <p>
        <LinkButton variant="primary" href="/" icon={<IconHome />}>
          Go to Recover
        </LinkButton>
      </p>
    </main>
  );
}
