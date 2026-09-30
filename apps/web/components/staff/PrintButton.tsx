'use client';

// The weekly report is the dashboard page itself, printed or saved as PDF from the browser (§17).
export function PrintButton() {
  return (
    <button type="button" className="btn" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
