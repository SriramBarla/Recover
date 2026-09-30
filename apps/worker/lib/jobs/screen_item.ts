// screen_item {itemId, policyVersion} (§10.2 layer 3, §10.4, §10.5; 11 Implementation guide; F-67;
// G-24, G-26, G-35, G-40). Advisory only: a result never publishes and a failure never blocks review.
// Idempotency: screening runs are unique per (photo, policy) in SQL, so a replay is a no-op insert.
import { canonicalFor } from '../keys.ts';
import { MAX_CANONICAL_BYTES } from '../media/canonicalize.ts';
import type { ScreeningTarget } from '../sys-types.ts';
import { PermanentError, RetryableError } from './errors.ts';
import { textField, uuidField } from './support.ts';
import type { JobCtx, Payload } from './types.ts';

export const kind = 'screen_item';

async function record(
  ctx: JobCtx,
  itemId: string,
  photoId: string,
  policyVersion: string,
  run: { provider: string; model: string; status: 'ok' | 'partial' | 'error'; signals: Record<string, unknown> },
): Promise<void> {
  await ctx.sys('system_record_screening', {
    p_item_id: itemId,
    p_photo_id: photoId,
    p_provider: run.provider,
    p_model: run.model,
    p_policy_version: policyVersion,
    p_status: run.status,
    p_signals: run.signals,
  });
}

export async function run(p: Payload, ctx: JobCtx): Promise<void> {
  const itemId = uuidField(p, 'itemId');
  const policyVersion = textField(p, 'policyVersion', /^[A-Za-z0-9._-]{1,20}$/); // screening_runs.policy_version <= 20
  // VISION_MODE=off: no provider, no budget, no run recorded; the item stays unscreened (G-40 sorts it first).
  if (ctx.vision.mode === 'off') return;

  const t = await ctx.sys<{ photos?: ScreeningTarget[] } | null>('system_screening_targets', {
    p_item_id: itemId,
    p_policy_version: policyVersion,
  });
  const photos = t?.photos ?? [];
  if (photos.length === 0) return;

  const budget = await ctx.sys<{ allowed: boolean; enabled: boolean }>('system_screening_budget_take', { p_images: photos.length });
  if (!budget?.enabled) return; // district switch off: skip the provider entirely, item stays unscreened (§10.5)

  const lastAttempt = ctx.job.attempts >= ctx.job.maxAttempts;
  for (const ph of photos) {
    if (!budget.allowed) {
      // Over the district daily ceiling: no provider call; error with flag `ceiling` (§10.5).
      await record(ctx, itemId, ph.photoId, policyVersion, { provider: ctx.vision.provider, model: 'none', status: 'error', signals: { ceiling: true } });
      continue;
    }
    const canonical = canonicalFor(ph.originalPath, itemId, ph.photoId, ctx.job.schoolId);
    try {
      const bytes = await ctx.storage.getBytes('originals', canonical.key, MAX_CANONICAL_BYTES);
      if (!bytes) throw new PermanentError('canonical_missing');
      const outcome = await ctx.vision.screen(bytes);
      if (outcome === null) return;
      await record(ctx, itemId, ph.photoId, policyVersion, outcome);
    } catch (e) {
      // Provider refused, or retries are exhausted: record an error run so reviewers see
      // `screening_error` and staff posts are not left waiting (§10.4). Otherwise retry the job.
      const code = e instanceof PermanentError || e instanceof RetryableError ? e.code : null;
      if (code !== null && (e instanceof PermanentError || lastAttempt)) {
        await record(ctx, itemId, ph.photoId, policyVersion, { provider: ctx.vision.provider, model: ctx.vision.model, status: 'error', signals: { error: code } });
        continue;
      }
      throw e;
    }
  }
}
