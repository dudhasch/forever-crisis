// fengari ships without types; the Lua C API is used through these loosely typed namespaces.
declare module 'fengari' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export const lua: any;
  export const lauxlib: any;
  export const lualib: any;
  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(s: Uint8Array): string;
}
