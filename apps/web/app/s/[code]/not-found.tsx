import Link from 'next/link';

export default function StudentNotFound() {
  return (
    <div className="container-narrow stack">
      <h1>We could not find that</h1>
      <p>The item may have been claimed or removed, or the school code may be wrong.</p>
      <p>
        <Link href="/" prefetch={false}>
          Enter a school code
        </Link>
      </p>
    </div>
  );
}
