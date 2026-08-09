export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{
    readonly value: T;
    readonly accepted: () => void;
  }> = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly onReturn: () => void | Promise<void>) {}

  push(value: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return Promise.resolve();
    }
    return new Promise<void>((accepted) => this.values.push({ value, accepted }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.values.splice(0)) entry.accepted();
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const entry = this.values.shift();
        if (entry !== undefined) {
          entry.accepted();
          return { done: false, value: entry.value };
        }
        if (this.closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        this.close();
        await this.onReturn();
        return { done: true, value: undefined };
      },
    };
  }
}
