// Date range for dashboards: a plain GET form so it works without JavaScript.
export function RangeForm({ from, to }: { from: string; to: string }) {
  return (
    <form method="get" className="row" aria-label="Date range">
      <label className="field">
        <span className="label">From</span>
        <input className="input" type="date" name="from" defaultValue={from} required />
      </label>
      <label className="field">
        <span className="label">To</span>
        <input className="input" type="date" name="to" defaultValue={to} required />
      </label>
      <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }}>
        Show
      </button>
    </form>
  );
}
