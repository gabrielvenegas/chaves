export interface PendingDebugWork {
  incidentId: number;
}

export class PendingDebugIncidentQueue<T extends PendingDebugWork> {
  private readonly items: T[] = [];
  private readonly incidentIds = new Set<number>();

  constructor(initialItems: readonly T[] = []) {
    for (const item of initialItems) {
      this.enqueue(item);
    }
  }

  enqueue(item: T): void {
    if (this.incidentIds.has(item.incidentId)) return;
    this.items.push(item);
    this.incidentIds.add(item.incidentId);
  }

  peek(): T | undefined {
    return this.items[0];
  }

  complete(incidentId: number): void {
    const current = this.items[0];
    if (!current || current.incidentId !== incidentId) {
      throw new Error("Debug incidents must complete in FIFO order.");
    }
    this.items.shift();
    this.incidentIds.delete(incidentId);
  }
}
