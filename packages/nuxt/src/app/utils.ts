/** @since 3.9.0 */
// 转为数组
export function toArray<T> (value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}
