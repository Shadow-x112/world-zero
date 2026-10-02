// A tiny synchronous event bus so systems can react to each other without
// depending on each other directly.

type Handler<T> = (payload: T) => void;

export interface WorldEvents {
  /** A new world day began (midnight). */
  newDay: { day: number };
  /** A new season began. */
  newSeason: { season: string; year: number };
  /** A new world year began. */
  newYear: { year: number };
  /** Light crossed into day. */
  dawn: { day: number };
  /** Light crossed into night. */
  dusk: { day: number };
}

export class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends keyof WorldEvents>(event: K, handler: Handler<WorldEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof WorldEvents>(event: K, payload: WorldEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) handler(payload);
  }
}
