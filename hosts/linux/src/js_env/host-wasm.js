// Generic host subset; all persistent JavaScript references stay in this heap.
(nativeCompile => {
  'use strict';
  const modules = new WeakMap();
  const instances = new WeakMap();
  class CompileError extends Error {}
  class LinkError extends Error {}
  class RuntimeError extends Error {}
  for (const C of [CompileError, LinkError, RuntimeError]) {
    Object.defineProperty(C.prototype, 'name', { value: C.name, configurable: true, writable: true });
  }
  function bytesOf(source) {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    throw new TypeError('WebAssembly.Module requires an ArrayBuffer or view');
  }
  class Module {
    constructor(bytes) {
      modules.set(this, nativeCompile(bytesOf(bytes), CompileError));
    }
  }
  class Instance {
    constructor(module, imports = {}) {
      const compiled = modules.get(module);
      if (!compiled) throw new TypeError('WebAssembly.Instance requires a compiled Module');
      if ((typeof imports !== 'object' || imports === null) && typeof imports !== 'function') {
        throw new TypeError('WebAssembly imports must be an object');
      }
      // Snapshot each import exactly once; later mutation of the source object
      // cannot switch callbacks behind an already instantiated module.
      const callbacks = compiled.imports.map(entry => {
        const namespace = imports[entry.module];
        if ((typeof namespace !== 'object' || namespace === null) && typeof namespace !== 'function') {
          throw new LinkError(`missing WebAssembly import module ${entry.module}`);
        }
        const callback = namespace[entry.name];
        if (typeof callback !== 'function') {
          throw new LinkError(`WebAssembly import ${entry.module}.${entry.name} is not callable`);
        }
        return callback;
      });
      const dispatch = (index, args) => {
        const value = Reflect.apply(callbacks[index], undefined, args);
        // ToInt32, deliberately NOT Number(value): BigInt must be refused.
        return compiled.imports[index].results === 0 ? 0 : value | 0;
      };
      const nativeCalls = compiled.instantiate(dispatch, RuntimeError);
      const exports = Object.create(null);
      compiled.exports.forEach((entry, index) => {
        const nativeCall = nativeCalls[index];
        const call = (...args) => nativeCall(
          Array.from({ length: entry.params }, (_, i) => args[i] | 0), dispatch, RuntimeError);
        Object.defineProperty(exports, entry.name, { value: call, enumerable: true });
      });
      instances.set(this, Object.freeze(exports));
    }
    get exports() {
      const exports = instances.get(this);
      if (!exports) throw new TypeError('incompatible WebAssembly.Instance receiver');
      return exports;
    }
  }
  globalThis.WebAssembly = {
    Module, Instance, CompileError, LinkError, RuntimeError,
    async compile(bytes) { return new Module(bytes); },
    async instantiate(module, imports) {
      // The byte-input overload is outside this host profile, not a silent
      // alternate result shape. Instance performs the unforgeable brand check.
      return new Instance(module, imports);
    },
  };
})
