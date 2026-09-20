/**
 * 固定容量环形缓冲区。超出容量后自动丢弃最旧数据,避免历史趋势数据无限增长——
 * 一个监控内存的插件,不该自己造成内存泄漏。
 * 真环形实现:写满后原地覆盖最旧槽位,而不是 push+shift 每次搬移整个数组。
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  /** 下一个写入位置;写满后同时是最旧元素位置。 */
  private head = 0;
  private filled = false;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity 必须大于 0');
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) {
      this.filled = true;
    }
  }

  toArray(): T[] {
    const length = this.length;
    const start = this.filled ? this.head : 0;
    const out: T[] = new Array<T>(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.buf[(start + i) % this.capacity] as T;
    }
    return out;
  }

  get length(): number {
    return this.filled ? this.capacity : this.head;
  }

  last(): T | undefined {
    if (this.length === 0) {
      return undefined;
    }
    return this.buf[(this.head - 1 + this.capacity) % this.capacity];
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.filled = false;
  }
}
