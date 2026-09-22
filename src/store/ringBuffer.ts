/**
 * 固定容量环形缓冲区。超出容量后自动丢弃最旧数据,避免历史趋势数据无限增长——
 * 一个监控内存的插件,不该自己造成内存泄漏。
 */
export class RingBuffer<T> {
  private buf: T[] = [];

  constructor(private capacity: number) {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity must be greater than 0');
    }
  }

  /**
   * 容量由"趋势窗口 ÷ 采集间隔"推导,两者都是可配置的,所以容量要能在运行时改——
   * 缩小时立刻丢掉最旧的数据,而不是等新数据一条条把它们挤出去(那样内存不会马上降下来)。
   */
  setCapacity(capacity: number): void {
    if (capacity <= 0) {
      throw new Error('RingBuffer capacity must be greater than 0');
    }
    this.capacity = capacity;
    if (this.buf.length > capacity) {
      this.buf = this.buf.slice(this.buf.length - capacity);
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
