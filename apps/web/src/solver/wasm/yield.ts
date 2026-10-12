// Zero-delay yield for the solver worker. `setTimeout(0)` is clamped to ≥ 4 ms once timers
// nest five deep (HTML timers spec, workers included) — that would add ~4 ms to every
// iteration chunk of a long solve. A MessageChannel round trip is a plain task: queued
// `carve` messages from the main thread still run first, so `hooks.cancelled()` sees them.

export function messageChannelYield(): () => Promise<void> {
  if (typeof MessageChannel === 'undefined') return () => new Promise((r) => setTimeout(r, 0));
  const channel = new MessageChannel();
  const waiting: (() => void)[] = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}
