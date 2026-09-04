/**
 * 固定容量环形缓冲区。超出容量后自动丢弃最旧数据,避免历史趋势数据无限增长——
 * 一个监控内存的插件,不该自己造成内存泄漏。
 */
export class RingBuffer<T> {
  private buf: T[] = [];

  constructor(private readonly capacity: number) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity 必须大于 0');
    }
  }

  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) {
      this.buf.shift();
    }
  }

  toArray(): T[] {
    return [...this.buf];
  }

  get length(): number {
    return this.buf.length;
  }

  last(): T | undefined {
    return this.buf[this.buf.length - 1];
  }

  clear(): void {
    this.buf = [];
  }
}
