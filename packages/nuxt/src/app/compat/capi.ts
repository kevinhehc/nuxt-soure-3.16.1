export * from 'vue'

export const install = () => {}

// target: 目标对象或数组。
//
// key: 属性名或数组索引，可以是字符串、数字或符号（Symbol）。
//
// val: 要设置的新值。
export function set (target: any, key: string | number | symbol, val: any) {
  if (Array.isArray(target)) {
    target.length = Math.max(target.length, key as number)
    target.splice(key as number, 1, val)
    return val
  }
  target[key] = val
  return val
}

// target: 目标对象或数组。
//
// key: 属性名或数组索引，要删除的元素或属性。
export function del (target: any, key: string | number | symbol) {
  if (Array.isArray(target)) {
    target.splice(key as number, 1)
    return
  }
  delete target[key]
}
