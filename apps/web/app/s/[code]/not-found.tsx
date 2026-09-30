// A plain anchor, not next/link: not-found boundaries ride along in every page's payload, and a
// Link here would pull the home page's chunks into every student route (JS budget).
import { buttonClass } from '@/components/ui/button.tsx';
import { IconArrowLeft } from '@/components/ui/icons.tsx';

export default function StudentNotFound() {
  return (
    <div className="container-narrow stack">
      <h1>We could not find that</h1>
      <p className="muted">The item may have been claimed or removed, or the school code may be wrong.</p>
      <p>
        <a className={buttonClass({})} href="/">
          <IconArrowLeft />
          Enter a school code
        </a>
      </p>
    </div>
  );
}
