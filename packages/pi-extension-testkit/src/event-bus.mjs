/**
 * Mini EventBus — matches the surface pi.events and rpc.ts rely on.
 * Pure, reusable across extensions.
 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit(event, data) {
      for (const h of [...(listeners.get(event) ?? [])]) h(data);
    },
    count(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}
