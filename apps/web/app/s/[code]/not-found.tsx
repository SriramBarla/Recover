import { LinkButton } from '@/components/ui/button.tsx';
import { IconArrowLeft } from '@/components/ui/icons.tsx';

export default function StudentNotFound() {
  return (
    <div className="container-narrow stack">
      <h1>We could not find that</h1>
      <p className="muted">The item may have been claimed or removed, or the school code may be wrong.</p>
      <p>
        <LinkButton href="/" prefetch={false} icon={<IconArrowLeft />}>
          Enter a school code
        </LinkButton>
      </p>
    </div>
  );
}
