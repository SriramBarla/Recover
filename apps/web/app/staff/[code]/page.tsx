// /staff/[code]: the queue is the landing page for a school (§5.3 step 1).
import { notFound, redirect } from 'next/navigation';

export default async function SchoolHome({ params }: PageProps<'/staff/[code]'>) {
  const { code } = await params;
  if (!/^[A-Z]{2,6}$/.test(code)) notFound();
  redirect(`/staff/${code}/queue`);
}
