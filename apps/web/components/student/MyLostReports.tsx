'use client';
// This browser's open lost reports and their matches (§12.3). Viewing marks reports with new matches as
// seen (F-63 funnel). api_mark_report_seen writes last_viewed_at, which bumps row_version
// (lost_reports_version trigger), so "This is it" and "Dismiss" stay disabled until the seen calls finish
// and the refreshed reports (with current row versions) arrive. A close that still loses a race (a new
// match landing meanwhile) re-reads the report once and retries.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { PublicLostReport, PublicMatch } from '@/lib/storage-url.ts';
import { apiFetch } from './client-api.ts';
import { categoryLabel, custodyLine, photoAlt } from './format.ts';

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
        {message && <p className={message.ok ? 'notice notice-ok' : 'notice notice-danger'}>{message.text}</p>}
      </div>
      {reports.length === 0 && (
        <div className="notice stack">
          <p>You have no open lost reports on this browser.</p>
          <p>
            <Link className="btn btn-primary" href={`/s/${code}/lost`} prefetch={false}>
              Report what you lost
            </Link>
          </p>
        </div>
      )}
      {reports.map((report) => (
        <article key={report.id} className="card stack" aria-labelledby={`report-${report.id}`}>
          <div className="spread">
            <h2 id={`report-${report.id}`}>{categoryLabel(report.category)}</h2>
            <span className="chips">
              <span className="badge">Open</span>
              {newOnOpen.has(report.id) && <span className="badge badge-warn">New match</span>}
            </span>
          </div>
          <p>{report.description}</p>
          <p className="small muted">Open until {report.expiresLabel}.</p>

          {report.matches.length === 0 ? (
            <p className="muted">No matches yet. We will show them here when a matching item is posted, so check back.</p>
          ) : (
            <>
              <h3>Possible matches</h3>
              <ul className="grid" aria-label="Possible matches" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {report.matches.map((m) => (
                  <li key={m.itemId} className="card item-card">
                    {m.thumbUrl ? (
                      <img className="thumb" src={m.thumbUrl} alt={photoAlt(m.category)} width={400} height={400} loading="lazy" decoding="async" />
                    ) : (
                      <div className="thumb" aria-hidden="true" />
                    )}
                    <div className="body stack">
                      <p className="desc">{m.description}</p>
                      <p className="small">
                        <span className="mono">{m.publicId}</span>
                        <br />
                        {custodyLine(m.custody, locationNames[m.locationId] ?? null)}
                      </p>
                      <Link href={`/s/${code}/items/${m.publicId}`} prefetch={false}>
                        View listing
                      </Link>
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        disabled={locked}
                        onClick={() => void close(report, 'found', m)}
                        aria-label={`This is it: ${m.publicId}`}
                      >
                        This is it
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div>
            <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => void close(report, 'dismiss')}>
              Dismiss this report
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
