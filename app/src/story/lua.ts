// Lua 5.3 host (fengari) for Ever Crisis field scripts.
//
// The game's own Lua library (generated/scripts/global.json) runs unchanged. It ends every high-level
// call in a native: `dungeon.<name>(…)` or a method on an engine object (`char.move(…)`, called with a
// dot). Both route to one JS host. Blocking calls are a native followed by `coroutine.yield(false)`:
// the native registers what it waits for on the calling thread, and the thread resumes once every wait
// is satisfied, optionally handing a value back to the yield (the gimmick object, the battle result…).
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from 'fengari';

export type LuaValue = null | boolean | number | string | LuaHandle | LuaValue[] | { [k: string]: LuaValue };

/** An engine object handed to Lua (character, gimmick, trigger, effect). */
export interface LuaHandle {
  readonly __handle: string;
}

export interface LuaHost {
  native(name: string, args: LuaValue[], thread: ScriptThread | null): LuaValue | void;
  method(handle: string, name: string, args: LuaValue[], thread: ScriptThread | null): LuaValue | void;
}

const PRELUDE = `
local __native, __method, __nilindex, rawget, rawset, setmetatable = __native, __method, __nilindex, rawget, rawset, setmetatable
-- The scripts pass undefined names (a typo'd character variable, an unexported constant) to library
-- functions that call methods on them; the game carries on, so indexing nil gives an inert object.
local NIL
NIL = setmetatable({}, { __index = function() return NIL end, __call = function() end })
debug.setmetatable(nil, { __index = function(_, k)
  __nilindex(tostring(k), debug.traceback("", 2))
  return NIL
end })
dungeon = setmetatable({}, { __index = function(t, k)
  local f = function(...) return __native(k, ...) end
  rawset(t, k, f)
  return f
end })
local handles = {}
local MT = { __index = function(h, k)
  local id = rawget(h, "__handle")
  return function(...) return __method(id, k, ...) end
end }
function __mkhandle(id)
  local h = handles[id]
  if not h then h = setmetatable({ __handle = id }, MT); handles[id] = h end
  return h
end
`;

/** Lua yields without a pending wait resume at once, up to this many times per frame. */
const MAX_RESUMES_PER_FRAME = 200;

export class ScriptThread {
  readonly L: unknown;
  private ref: number;
  private waits: (() => boolean)[] = [];
  private resumeValue: LuaValue | undefined;
  private started = false;
  done = false;
  error: string | null = null;
  private resolveDone: (() => void) | null = null;
  readonly finished: Promise<void>;

  constructor(
    readonly vm: LuaVM,
    readonly name: string,
  ) {
    this.L = lua.lua_newthread(vm.L);
    mainOf.set(this.L as object, vm.L);
    this.ref = lauxlib.luaL_ref(vm.L, lua.LUA_REGISTRYINDEX);
    this.finished = new Promise((r) => (this.resolveDone = r));
  }

  /** Block the next yield until `pred` holds. */
  waitFor(pred: () => boolean) {
    this.waits.push(pred);
  }

  /** Hand `v` to the Lua code as the result of its next yield. */
  resumeWith(v: LuaValue) {
    this.resumeValue = v;
  }

  /** Push `fn` from `env` onto the thread; it starts on the next step(). */
  prepare(env: number, fn: string, args: LuaValue[]) {
    const T = this.L;
    lua.lua_rawgeti(T, lua.LUA_REGISTRYINDEX, env);
    lua.lua_getfield(T, -1, to_luastring(fn));
    lua.lua_remove(T, -2);
    if (lua.lua_type(T, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_settop(T, 0);
      this.finish();
      return false;
    }
    for (const a of args) pushValue(T, a);
    this.pendingArgs = args.length;
    return true;
  }
  private pendingArgs = 0;

  /** Run until the script blocks on something that is not ready yet, or ends. */
  step() {
    for (let i = 0; i < MAX_RESUMES_PER_FRAME && !this.done; i++) {
      if (this.waits.some((w) => !w())) return;
      this.waits = [];
      let nargs = 0;
      if (!this.started) {
        this.started = true;
        nargs = this.pendingArgs;
      } else {
        lua.lua_settop(this.L, 0);
        if (this.resumeValue !== undefined) {
          pushValue(this.L, this.resumeValue);
          nargs = 1;
        }
      }
      this.resumeValue = undefined;
      const prev = this.vm.current;
      this.vm.current = this;
      const status = lua.lua_resume(this.L, null, nargs);
      this.vm.current = prev;
      if (status === lua.LUA_YIELD) continue;
      if (status !== lua.LUA_OK) {
        this.error = lua.lua_type(this.L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(this.L, -1)) : `status ${status}`;
        // The coroutine's stack survives a failed resume: name the script lines that led here.
        lauxlib.luaL_traceback(this.vm.L, this.L, to_luastring(this.error), 0);
        const trace = to_jsstring(lua.lua_tostring(this.vm.L, -1));
        lua.lua_pop(this.vm.L, 1);
        console.warn(`[lua] ${this.name}: ${trace.replace(/\n\s+/g, ' <- ')}`);
      }
      this.finish();
    }
  }

  kill() {
    this.finish();
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.waits = [];
    lauxlib.luaL_unref(this.vm.L, lua.LUA_REGISTRYINDEX, this.ref);
    this.vm.threads.delete(this);
    this.resolveDone?.();
  }
}

export class LuaVM {
  readonly L: unknown;
  readonly threads = new Set<ScriptThread>();
  current: ScriptThread | null = null;

  constructor(private host: LuaHost) {
    const L = lauxlib.luaL_newstate();
    this.L = L;
    lualib.luaL_openlibs(L);
    lua.lua_pushjsfunction(L, (T: unknown) => this.onNative(T));
    lua.lua_setglobal(L, to_luastring('__native'));
    lua.lua_pushjsfunction(L, (T: unknown) => this.onMethod(T));
    lua.lua_setglobal(L, to_luastring('__method'));
    lua.lua_pushjsfunction(L, (T: unknown) => this.onNilIndex(T));
    lua.lua_setglobal(L, to_luastring('__nilindex'));
    this.exec(PRELUDE, 'prelude');
  }

  /** Run a chunk in the global environment (library, defines). */
  exec(src: string, name = 'chunk') {
    const L = this.L;
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(`=${name}`)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      throw new Error(`${name}: ${msg}`);
    }
  }

  /**
   * Load a script file into its own environment inheriting _G (each file defines check/execute_N/skip_N…).
   * Returns the environment's registry reference; release it with unref().
   */
  load(src: string, name: string): number {
    const L = this.L;
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(`=${name}`)) !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      throw new Error(`${name}: ${msg}`);
    }
    lua.lua_newtable(L);
    lua.lua_newtable(L);
    lua.lua_pushglobaltable(L);
    lua.lua_setfield(L, -2, to_luastring('__index'));
    lua.lua_setmetatable(L, -2);
    lua.lua_pushvalue(L, -1);
    const env = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    lua.lua_setupvalue(L, -2, 1); // the chunk's _ENV
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, env);
      throw new Error(`${name}: ${msg}`);
    }
    return env;
  }

  unref(env: number) {
    lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, env);
  }

  has(env: number, fn: string) {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, env);
    lua.lua_getfield(L, -1, to_luastring(fn));
    const ok = lua.lua_type(L, -1) === lua.LUA_TFUNCTION;
    lua.lua_pop(L, 2);
    return ok;
  }

  /** Call a function synchronously (check()). Natives see no thread, so nothing can wait. */
  callSync(env: number, fn: string, name: string): LuaValue | undefined {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, env);
    lua.lua_getfield(L, -1, to_luastring(fn));
    lua.lua_remove(L, -2);
    if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_pop(L, 1);
      return undefined;
    }
    const prev = this.current;
    this.current = null;
    const status = lua.lua_pcall(L, 0, 1, 0);
    this.current = prev;
    if (status !== lua.LUA_OK) {
      console.warn(`[lua] ${name}.${fn}: ${to_jsstring(lua.lua_tostring(L, -1))}`);
      lua.lua_pop(L, 1);
      return undefined;
    }
    const v = readValue(L, -1);
    lua.lua_pop(L, 1);
    return v;
  }

  /** Start `fn` of a loaded script as a coroutine. It runs up to its first blocking wait right away. */
  spawn(env: number, fn: string, name: string, ...args: LuaValue[]) {
    const t = new ScriptThread(this, `${name}.${fn}`);
    if (t.prepare(env, fn, args)) {
      this.threads.add(t);
      t.step();
    }
    return t;
  }

  /** Resume every thread whose waits are met (call once per frame). */
  update() {
    for (const t of [...this.threads]) {
      try {
        t.step();
      } catch (e) {
        t.error = String(e);
        console.warn(`[lua] ${t.name}`, e);
        t.kill();
      }
    }
  }

  killAll() {
    for (const t of [...this.threads]) t.kill();
  }

  private args(T: unknown, from: number) {
    const n = lua.lua_gettop(T);
    const out: LuaValue[] = [];
    for (let i = from; i <= n; i++) out.push(readValue(T, i));
    return out;
  }

  private ret(T: unknown, v: LuaValue | void) {
    lua.lua_settop(T, 0);
    if (v === undefined) return 0;
    pushValue(T, v);
    return 1;
  }

  private nilSeen = new Set<string>();

  /** A script indexed nil (see PRELUDE): note where, once. */
  private onNilIndex(T: unknown): number {
    const key = to_jsstring(lua.lua_tostring(T, 1));
    // Frames are "stack traceback:" then the metamethod, the library helper(s), the script that called them.
    const frames = to_jsstring(lua.lua_tostring(T, 2)).split('\n').slice(2).map((l) => l.trim());
    const where = frames.find((f) => !f.startsWith('lua_dungeon_')) ?? frames[0] ?? '?';
    const id = `${this.current?.name ?? ''} ${where}`;
    if (!this.nilSeen.has(id)) {
      this.nilSeen.add(id);
      console.debug(`[lua] ${this.current?.name ?? '?'}: indexed nil (.${key}) from ${where}`);
    }
    return 0;
  }

  private onNative(T: unknown): number {
    const name = to_jsstring(lua.lua_tostring(T, 1));
    const args = this.args(T, 2);
    let v: LuaValue | void = undefined;
    try {
      v = this.host.native(name, args, this.current);
    } catch (e) {
      console.warn(`[lua] dungeon.${name}`, e);
    }
    return this.ret(T, v);
  }

  private onMethod(T: unknown): number {
    const id = to_jsstring(lua.lua_tostring(T, 1));
    const name = to_jsstring(lua.lua_tostring(T, 2));
    const args = this.args(T, 3);
    let v: LuaValue | void = undefined;
    try {
      v = this.host.method(id, name, args, this.current);
    } catch (e) {
      console.warn(`[lua] ${id}.${name}`, e);
    }
    return this.ret(T, v);
  }
}

/** Coroutine state -> its main state (for building handles). */
const mainOf = new WeakMap<object, unknown>();

function readValue(L: unknown, i: number, depth = 0): LuaValue {
  switch (lua.lua_type(L, i)) {
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, i);
    case lua.LUA_TSTRING:
      return to_jsstring(lua.lua_tostring(L, i));
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, i);
    case lua.LUA_TTABLE: {
      if (depth > 5) return null;
      const idx = lua.lua_absindex(L, i);
      lua.lua_pushstring(L, to_luastring('__handle'));
      lua.lua_rawget(L, idx);
      if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
        const h = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        return { __handle: h };
      }
      lua.lua_pop(L, 1);
      const len = lua.lua_rawlen(L, idx);
      if (len > 0) {
        const arr: LuaValue[] = [];
        for (let k = 1; k <= len; k++) {
          lua.lua_rawgeti(L, idx, k);
          arr.push(readValue(L, -1, depth + 1));
          lua.lua_pop(L, 1);
        }
        return arr;
      }
      const obj: Record<string, LuaValue> = {};
      lua.lua_pushnil(L);
      while (lua.lua_next(L, idx) !== 0) {
        if (lua.lua_type(L, -2) === lua.LUA_TSTRING) obj[to_jsstring(lua.lua_tostring(L, -2))] = readValue(L, -1, depth + 1);
        lua.lua_pop(L, 1);
      }
      return obj;
    }
    default:
      return null;
  }
}

function pushValue(L: unknown, v: LuaValue) {
  if (v === null || v === undefined) lua.lua_pushnil(L);
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
  else if (typeof v === 'number') lua.lua_pushnumber(L, v);
  else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
  else if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((x, i) => {
      pushValue(L, x);
      lua.lua_rawseti(L, -2, i + 1);
    });
  } else if ('__handle' in v && typeof v.__handle === 'string') {
    // Built on the main state: a suspended coroutine cannot run calls itself.
    const M = mainOf.get(L as object) ?? L;
    lua.lua_getglobal(M, to_luastring('__mkhandle'));
    lua.lua_pushstring(M, to_luastring(v.__handle));
    lua.lua_call(M, 1, 1);
    if (M !== L) lua.lua_xmove(M, L, 1);
  } else {
    lua.lua_createtable(L, 0, 0);
    for (const [k, x] of Object.entries(v)) {
      pushValue(L, x as LuaValue);
      lua.lua_setfield(L, -2, to_luastring(k));
    }
  }
}
