// Stepper: wizard progress. The text ("Step 2 of 5" plus the step name) is what assistive
// technology reads; the segmented bar is a visual echo and is hidden from it. The current
// segment is half-filled, so progress never relies on color alone.
// On step change, move focus to the new step's heading (tabIndex={-1}) so the change is heard.
import { cx } from './cx.ts';

export function Stepper({ steps, current, className }: { steps: readonly string[]; current: number; className?: string }) {
  const total = steps.length;
  const at = Math.min(Math.max(current, 1), total);
  return (
    <div className={cx('stepper', className)}>
      <p className="stepper-count">
        <span>
          Step {at} of {total}
        </span>
        <span aria-hidden="true">·</span>
        <span className="stepper-name">{steps[at - 1]}</span>
      </p>
      <ol className="steps" aria-hidden="true">
        {steps.map((name, i) => {
          const state = i + 1 < at ? 'done' : i + 1 === at ? 'current' : 'todo';
          return <li key={name} data-state={state} data-done={state === 'done' ? 'true' : undefined} />;
        })}
      </ol>
    </div>
  );
}
