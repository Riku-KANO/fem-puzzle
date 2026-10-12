// Number formatting for the HUD.

export function percent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Residuals like 1.2e-4 */
export function sci(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toExponential(1);
}
