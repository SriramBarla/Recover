// Operating-calendar CSV (`day,is_open,open_at,close_at`, §24 implementation guide) to the
// api_staff_calendar_upsert shape. Pure, so node --test covers it. Mirrors the
// school_calendar_days CHECK: open days need open_at < close_at; closed days have neither.

export type CalendarRow = { day: string; isOpen: boolean; openAt: string | null; closeAt: string | null };

const TRUE = new Set(['true', '1', 'yes', 'y', 'open']);
const FALSE = new Set(['false', '0', 'no', 'n', 'closed']);
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

function validDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function time(s: string): string | null {
  const m = TIME_RE.exec(s);
  if (!m) return null;
  return `${m[1]!.padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
}

export function parseCalendarCsv(text: string, maxErrors = 20): { rows: CalendarRow[]; errors: string[] } {
  const rows: CalendarRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (errors.length >= maxErrors) return;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(',').map(unquote);
    const n = i + 1;
    if (i === 0 && cells[0]?.toLowerCase() === 'day') return; // header
    const [day = '', open = '', openAt = '', closeAt = ''] = cells;
    if (cells.length > 4 && cells.slice(4).some((c) => c !== '')) {
      errors.push(`Line ${n}: expected 4 columns (day,is_open,open_at,close_at).`);
      return;
    }
    if (!validDay(day)) {
      errors.push(`Line ${n}: "${day}" is not a date like 2026-10-01.`);
      return;
    }
    if (seen.has(day)) {
      errors.push(`Line ${n}: ${day} appears more than once.`);
      return;
    }
    const o = open.toLowerCase();
    if (!TRUE.has(o) && !FALSE.has(o)) {
      errors.push(`Line ${n}: is_open must be true or false.`);
      return;
    }
    const isOpen = TRUE.has(o);
    if (!isOpen) {
      if (openAt || closeAt) {
        errors.push(`Line ${n}: a closed day has no open or close time.`);
        return;
      }
      seen.add(day);
      rows.push({ day, isOpen, openAt: null, closeAt: null });
      return;
    }
    const a = time(openAt);
    const b = time(closeAt);
    if (!a || !b) {
      errors.push(`Line ${n}: open days need open_at and close_at like 07:45 and 15:30.`);
      return;
    }
    if (a >= b) {
      errors.push(`Line ${n}: close_at must be after open_at.`);
      return;
    }
    seen.add(day);
    rows.push({ day, isOpen, openAt: a, closeAt: b });
  });
  rows.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));
  return { rows, errors };
}

export function summarize(rows: CalendarRow[]): { first: string | null; last: string | null; open: number; closed: number } {
  return {
    first: rows[0]?.day ?? null,
    last: rows[rows.length - 1]?.day ?? null,
    open: rows.filter((r) => r.isOpen).length,
    closed: rows.filter((r) => !r.isOpen).length,
  };
}
