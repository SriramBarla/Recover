'use client';
// This browser's open lost reports and their matches (§12.3). Viewing marks reports with new matches as
// seen (F-63 funnel). api_mark_report_seen writes last_viewed_at, which bumps row_version
// (lost_reports_version trigger), so "This is it" and "Dismiss" stay disabled until the seen calls finish
// and the refreshed reports (with current row versions) arrive. A close that still loses a race (a new
// match landing meanwhile) re-reads the report once and retries.
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { PublicLostReport, PublicMatch } from '@/lib/storage-url.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button, LinkButton } from '@/components/ui/button.tsx';
import { CategoryIcon } from '@/components/ui/category.tsx';
import { EmptyState } from '@/components/ui/empty-state.tsx';
import { IconBell, IconCheck, IconChevronRight, IconClock, IconSearch, IconX } from '@/components/ui/icons.tsx';
import { ItemCard } from '@/components/ui/item-card.tsx';
import { Notice } from '@/components/ui/notice.tsx';
import { StatusBadge } from '@/components/ui/status-badge.tsx';
import { apiFetch } from './client-api.ts';
import { categoryLabel } from './format.ts';

export type ReportView = PublicLostReport & { hasNew: boolean; expiresLabel: string };

export function MyLostReports({
  code,
  reports,
  locationNames,
}: {
  code: string;
  reports: ReportView[];
  locationNames: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const seen = useRef(false);
  // Badges reflect what was new when the page opened, even after marking seen refreshes the data.
  const [newOnOpen] = useState(() => new Set(reports.filter((r) => r.hasNew).map((r) => r.id)));
  const [marking, setMarking] = useState(newOnOpen.size > 0);
  const [refreshing, startRefresh] = useTransition();
  const locked = marking || refreshing || busy !== null;

  useEffect(() => {
    if (seen.current) return;
    seen.current = true;
    const unseen = reports.filter((r) => r.hasNew);
    if (unseen.length === 0) return;
    void Promise.all(unseen.map((r) => apiFetch(`/api/s/${code}/lost-reports/${r.id}/seen`, { method: 'POST' }))).then(() => {
      // Both updates land in one render: the transition keeps the actions locked until fresh data arrives.
      startRefresh(() => router.refresh());
      setMarking(false);
    });
  }, [code, reports, router]);

  async function close(report: ReportView, outcome: 'found' | 'dismiss', match?: PublicMatch) {
    setBusy(report.id);
    setMessage(null);
    const post = (rowVersion: number) =>
      apiFetch<{ reportId: string; status: string }>(`/api/s/${code}/lost-reports/${report.id}/close`, {
        method: 'POST',
        body: { rowVersion, outcome },
      });
    let r = await post(report.rowVersion);
    if (!r.ok && r.error.code === 'state_changed') {
      const fresh = await apiFetch<{ reports: PublicLostReport[] }>(`/api/s/${code}/lost-reports`);
      const current = fresh.ok ? fresh.data.reports.find((x) => x.id === report.id) : undefined;
      if (current) r = await post(current.rowVersion);
    }
    setBusy(null);
    if (!r.ok) {
      setMessage({ ok: false, text: r.error.message });
      return;
    }
    const where = match ? (locationNames[match.locationId] ?? 'the office') : '';
    setMessage({
      ok: true,
      text:
        outcome === 'found' && match
          ? `Great! Go to ${where} and give them item ID ${match.publicId}. Staff will check that it is yours.`
          : 'Report dismissed.',
    });
    startRefresh(() => router.refresh());
  }

  // The empty state renders here, not in the page, so the confirmation survives the refresh that removes
  // the report it is about.
  return (
    <div className="stack-lg">
      <div aria-live="polite">
        {message && (
          <Notice tone={message.ok ? 'success' : 'danger'}>
            <p>{message.text}</p>
          </Notice>
        )}
      </div>
      {reports.length === 0 && (
        <EmptyState
          title="You have no open lost reports on this browser."
          icon={<IconSearch />}
          actions={
            <LinkButton variant="primary" href={`/s/${code}/lost`} prefetch={false} icon={<IconSearch />}>
              Report what you lost
            </LinkButton>
          }
        >
          When you report something, we show you matching found items here.
        </EmptyState>
      )}
      {reports.map((report) => (
        <article key={report.id} className="card stack" aria-labelledby={`report-${report.id}`}>
          <div className="spread">
            <h2 id={`report-${report.id}`} className="with-icon">
              <CategoryIcon category={report.category} size={22} />
              {categoryLabel(report.category)}
            </h2>
            <span className="chips">
              <StatusBadge kind="report" status="open" />
              {newOnOpen.has(report.id) && (
                <Badge tone="accent" icon={<IconBell />}>
                  New match
                </Badge>
              )}
            </span>
          </div>
          <p>{report.description}</p>
          <p className="small muted with-icon">
            <IconClock size={16} />
            Open until {report.expiresLabel}.
          </p>

          {report.matches.length === 0 ? (
            <p className="muted">No matches yet. We will show them here when a matching item is posted, so check back.</p>
          ) : (
            <>
              <h3>Possible matches</h3>
              <ul className="item-list" aria-label="Possible matches">
                {report.matches.map((m) => (
                  <li key={m.itemId}>
                    <ItemCard
                      variant="row"
                      publicId={m.publicId}
                      category={m.category}
                      description={m.description}
                      photo={m.thumbUrl ? { url: m.thumbUrl } : null}
                      custody={m.custody}
                      locationName={locationNames[m.locationId] ?? null}
                      actions={
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={locked}
                            onClick={() => void close(report, 'found', m)}
                            aria-label={`This is it: ${m.publicId}`}
                            icon={<IconCheck />}
                          >
                            This is it
                          </Button>
                          <LinkButton variant="ghost" size="sm" href={`/s/${code}/items/${m.publicId}`} prefetch={false} iconEnd={<IconChevronRight />}>
                            View listing
                          </LinkButton>
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <div>
            <Button variant="ghost" disabled={locked} onClick={() => void close(report, 'dismiss')} icon={<IconX />}>
              Dismiss this report
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
