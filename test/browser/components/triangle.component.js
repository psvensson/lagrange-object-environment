"use components";
import print from '../../../src/browser-renderer/print.js';
import { Context } from '../../../src/browser-renderer/surface-webgpu.js';
import { Surface } from '../../../src/browser-renderer/surface.js';
import { Gpu, GpuAdapter, GpuBindGroupLayout, GpuCommandBuffer, GpuCommandEncoder, GpuDevice, GpuPipelineLayout, GpuQuerySet, GpuQueue, GpuRenderPassEncoder, GpuRenderPipeline, GpuShaderModule, GpuTexture, GpuTextureView, RecordGpuPipelineConstantValue, RecordOptionGpuSize64, getGpu } from '../../../src/browser-renderer/webgpu.js';

const emptyFunc = () => {};

let dv = new DataView(new ArrayBuffer());
const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);

function toInt32(val) {
  
  return val >> 0;
}


function _isValidNumericPrimitive(ty, v) {
  if (v === undefined || v === null) { return false; }
  switch (ty) {
    case 'bool':
    return v === 0 || v === 1;
    break;
    case 'u8':
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
    break;
    case 's8':
    return typeof v === 'number' && Number.isInteger(v) && v >= -128 && v <= 127;
    break;
    case 'u16':
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535;
    break;
    case 's16':
    return typeof v === 'number' && Number.isInteger(v) && v >= -32768 && v <= 32767;
    case 'u32':
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4_294_967_295;
    case 's32':
    return typeof v === 'number' && Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647;
    case 'u64':
    return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
    case 's64':
    return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
    break;
    case 'f32':
    case 'f64': return typeof v === 'number';
    default:
    return false;
  }
  return true;
}

function _requireValidNumericPrimitive(ty, v) {
  if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
    throw new TypeError(`invalid ${ty} value [${v}]`);
  }
  return true;
}
const utf16Decoder = new TextDecoder('utf-16');

const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function _utf16AllocateAndEncode(str, realloc, memory) {
  const len = str.length;
  const ptr = realloc(0, 0, 2, len * 2);
  const out = new Uint16Array(memory.buffer, ptr, len);
  let i = 0;
  if (isLE) {
    while (i < len) { out[i] = str.charCodeAt(i++); }
  } else {
    while (i < len) {
      const ch = str.charCodeAt(i);
      out[i++] = (ch & 0xff) << 8 | ch >>> 8;
    }
  }
  return { ptr, len, codepoints: [...str].length };
}

const TEXT_DECODER_UTF8 = new TextDecoder();
const TEXT_ENCODER_UTF8 = new TextEncoder();

function _utf8AllocateAndEncode(s, realloc, memory) {
  if (typeof s !== 'string') {
    throw new TypeError('expected a string, received [' + typeof s + ']');
  }
  if (s.length === 0) { return { ptr: 1, len: 0 }; }
  // Compute the exact allocation size up front. Some older preview1
  // adapters only support an initial allocation, not a subsequent shrink.
  let len = 0;
  let codepoints = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    codepoints++;
    if (ch < 0x80) { len += 1; }
    else if (ch < 0x800) { len += 2; }
    else if (ch >= 0xd800 && ch <= 0xdbff &&
    i + 1 < s.length &&
    (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      len += 4;
      i++;
    } else { len += 3; }
  }
  const ptr = realloc(0, 0, 1, len);
  const { read, written } = TEXT_ENCODER_UTF8.encodeInto(
  s,
  new Uint8Array(memory.buffer, ptr, len),
  );
  if (read !== s.length || written !== len) {
    throw new Error('failed to encode whole string');
  }
  const res = { ptr, len, codepoints };
  return res;
}


async function _utf8AllocateAndEncodeAsync(s, realloc, memory) {
  if (typeof s !== 'string') {
    throw new TypeError('expected a string, received [' + typeof s + ']');
  }
  if (s.length === 0) { return { ptr: 1, len: 0 }; }
  // Compute the exact allocation size up front. Some older preview1
  // adapters only support an initial allocation, not a subsequent shrink.
  let len = 0;
  let codepoints = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    codepoints++;
    if (ch < 0x80) { len += 1; }
    else if (ch < 0x800) { len += 2; }
    else if (ch >= 0xd800 && ch <= 0xdbff &&
    i + 1 < s.length &&
    (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      len += 4;
      i++;
    } else { len += 3; }
  }
  const ptr = await realloc(0, 0, 1, len);
  const { read, written } = TEXT_ENCODER_UTF8.encodeInto(
  s,
  new Uint8Array(memory.buffer, ptr, len),
  );
  if (read !== s.length || written !== len) {
    throw new Error('failed to encode whole string');
  }
  const res = { ptr, len, codepoints };
  return res;
}

const T_FLAG = 1 << 30;

function rscTableCreateOwn(table, rep) {
  const free = table[0] & ~T_FLAG;
  table._createdReps.add(rep);
  if (free === 0) {
    table.push(0);
    table.push(rep | T_FLAG);
    return (table.length >> 1) - 1;
  }
  table[0] = table[free << 1];
  table[free << 1] = 0;
  table[(free << 1) + 1] = rep | T_FLAG;
  return free;
}


function rscTableRemove(table, handle) {
  const scope = table[handle << 1];
  const val = table[(handle << 1) + 1];
  const own = (val & T_FLAG) !== 0;
  const rep = val & ~T_FLAG;
  if (val === 0 || (scope & T_FLAG) !== 0) {
    throw new TypeError("Invalid handle");
  }
  table[handle << 1] = table[0] | T_FLAG;
  table[0] = handle | T_FLAG;
  return { rep, scope, own };
}


let curResourceBorrows = [];
const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
const ASYNC_CURRENT_TASK_IDS = [];
const ASYNC_CURRENT_COMPONENT_IDXS = [];

const _debugLog = (...args) => {
  if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
  console.debug(...args);
};

function clearCurrentTask(componentIdx, taskID) {
  _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });
  
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while ending current task');
  }
  
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (!tasks || !Array.isArray(tasks)) {
    throw new Error('missing/invalid tasks for component instance while ending task');
  }
  if (tasks.length == 0) {
    throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
  }
  
  if (taskID !== undefined) {
    const last = tasks[tasks.length - 1];
    if (last.id !== taskID) {
      // throw new Error('current task does not match expected task ID');
      return;
    }
  }
  
  ASYNC_CURRENT_TASK_IDS.pop();
  ASYNC_CURRENT_COMPONENT_IDXS.pop();
  
  const taskMeta = tasks.pop();
  return taskMeta.task;
}
const ASYNC_STATE = new Map();

function promiseWithResolvers() {
  if (Promise.withResolvers) {
    return Promise.withResolvers();
  } else {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
}

class Waitable {
  #componentIdx;
  
  #pendingEventFn = null;
  
  #promise;
  #resolve;
  #reject;
  
  #waitableSet = null;
  
  #hasSyncWaiter = false;
  
  #idx = null; // to component-global waitables
  
  target;
  
  constructor(args) {
    const { componentIdx, target } = args;
    this.#componentIdx = componentIdx;
    this.target = args.target;
    this.#resetPromise();
  }
  
  componentIdx() { return this.#componentIdx; }
  isInSet() { return this.#waitableSet !== null; }
  
  idx() { return this.#idx; }
  setIdx(idx) {
    if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
    this.#idx = idx;
  }
  
  setTarget(tgt) { this.target = tgt; }
  
  #resetPromise() {
    const { promise, resolve, reject } = promiseWithResolvers()
    this.#promise = promise;
    this.#resolve = resolve;
    this.#reject = reject;
  }
  
  resolve() { this.#resolve(); }
  reject(err) { this.#reject(err); }
  promise() { return this.#promise; }
  
  hasPendingEvent() {
    // _debugLog('[Waitable#hasPendingEvent()]', {
      //     componentIdx: this.#componentIdx,
      //     waitable: this,
      //     waitableSet: this.#waitableSet,
      //     hasPendingEvent: this.#pendingEventFn !== null,
      // });
      return this.#pendingEventFn !== null;
    }
    
    setPendingEvent(fn) {
      _debugLog('[Waitable#setPendingEvent()] args', {
        waitable: this,
        inSet: this.#waitableSet,
      });
      this.#pendingEventFn = fn;
    }
    
    getPendingEvent() {
      _debugLog('[Waitable#getPendingEvent()] args', {
        waitable: this,
        inSet: this.#waitableSet,
        hasPendingEvent: this.#pendingEventFn !== null,
      });
      if (this.#pendingEventFn === null) { return null; }
      const eventFn = this.#pendingEventFn;
      this.#pendingEventFn = null;
      const e = eventFn();
      this.#resetPromise();
      return e;
    }
    
    join(waitableSet) {
      _debugLog('[Waitable#join()] args', {
        waitable: this,
        waitableSet: waitableSet,
        isRemoval: waitableSet === null,
      });
      
      if (this.#waitableSet === undefined) {
        throw new TypeError('waitable set must be not be undefined');
      }
      
      if (this.#waitableSet) {
        this.#waitableSet.removeWaitable(this);
      }
      
      this.#waitableSet = waitableSet;
      
      if (waitableSet) {
        this.#waitableSet.addWaitable(this);
      }
    }
    
    drop() {
      _debugLog('[Waitable#drop()] args', {
        componentIdx: this.#componentIdx,
        waitable: this,
      });
      if (this.hasPendingEvent()) {
        throw new Error('waitables with pending events cannot be dropped');
      }
      this.join(null);
    }
    
    async waitForPendingEvent(args) {
      const { cstate } = args;
      if (!cstate) { throw new TypeError('missing component state'); }
      
      if (this.#waitableSet !== null || this.#hasSyncWaiter) {
        throw new Error("waitable is already in a set/has a sync waiter");
      }
      this.#hasSyncWaiter = true;
      await cstate.waitUntil({
        cancellable: false,
        readyFn: () => this.hasPendingEvent(),
      });
      this.#hasSyncWaiter = false;
    }
    
  }
  const INSTANCE_FLAGS = new Map();
  const STORE_TRAP = { error: null };
  const WebAssemblyRuntimeError = WebAssembly.RuntimeError;
  
  class RepTable {
    // Sentinel marking a freed slot; the freelist link for a freed slot
    // lives in the odd cell. This keeps get()/contains()/remove() on freed
    // reps well-defined (previously they returned/corrupted freelist links).
    static FREE = Symbol('RepTable.free');
    
    #data = [0, null];
    #size = 0;
    #target;
    
    constructor(args) {
      this.target = args?.target;
    }
    
    data() { return this.#data; }
    
    insert(val) {
      _debugLog('[RepTable#insert()] args', { val, target: this.target });
      const freeIdx = this.#data[0];
      if (freeIdx === 0) {
        this.#data.push(val);
        this.#data.push(null);
        const rep = (this.#data.length >> 1) - 1;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
        this.#size += 1;
        return rep;
      }
      const placementIdx = freeIdx << 1;
      if (this.#data[placementIdx] !== RepTable.FREE) {
        throw new Error('corrupt rep table freelist: head does not point at a freed slot');
      }
      this.#data[0] = this.#data[placementIdx + 1];
      this.#data[placementIdx] = val;
      this.#data[placementIdx + 1] = null;
      _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
      this.#size += 1;
      return freeIdx;
    }
    
    get(rep) {
      _debugLog('[RepTable#get()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      if (val === RepTable.FREE) { return undefined; }
      return val;
    }
    
    contains(rep) {
      _debugLog('[RepTable#contains()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      return val !== RepTable.FREE && !!val;
    }
    
    remove(rep) {
      _debugLog('[RepTable#remove()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
      if (this.#data.length === 2) { throw new Error('invalid'); }
      
      const baseIdx = rep << 1;
      if (baseIdx >= this.#data.length) {
        throw new Error(`invalid rep [${rep}] during remove, out of range`);
      }
      const val = this.#data[baseIdx];
      if (val === RepTable.FREE) {
        throw new Error(`double removal of rep [${rep}] (already freed)`);
      }
      
      this.#data[baseIdx] = RepTable.FREE;
      this.#data[baseIdx + 1] = this.#data[0];
      this.#data[0] = rep;
      this.#size -= 1;
      
      return val;
    }
    
    size() { return this.#size; }
    
    clear() {
      _debugLog('[RepTable#clear()] args', { rep, target: this.target });
      this.#data = [0, null];
    }
  }
  
  class ComponentAsyncState {
    static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
    
    static TickResult = {
      // no suspended tasks remain
      DONE: 'done',
      // a suspended task was resumed (more may be ready)
      RESUMED: 'resumed',
      // suspended tasks remain but none were ready
      IDLE: 'idle',
    };
    
    #componentIdx;
    #callingAsyncImport = false;
    #syncImportWait = promiseWithResolvers();
    #lockHolderTaskID = null;
    #lockWaiters = [];
    #lockHandoffScheduled = false;
    #parkedTasks = new Map();
    #suspendedTasksByTaskID = new Map();
    #suspendedTaskIDs = [];
    #errored = null;
    #backpressure = 0;
    #backpressureWaiters = 0n;
    
    #handlerMap = new Map();
    #nextHandlerID = 0n;
    
    #tickLoop = null;
    #tickLoopInterval = null;
    
    #onExclusiveReleaseHandlers = [];
    
    #mayLeave = true;
    
    handles;
    subtasks;
    
    constructor(args) {
      this.#componentIdx = args.componentIdx;
      this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
      this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
    };
    
    componentIdx() { return this.#componentIdx; }
    
    get mayLeave() {
      const flags = INSTANCE_FLAGS.get(this.#componentIdx);
      return flags === undefined ? this.#mayLeave : flags.value === 1;
    }
    set mayLeave(value) {
      if (typeof value !== 'boolean') { throw new TypeError('mayLeave must be a boolean'); }
      this.#mayLeave = value;
      const flags = INSTANCE_FLAGS.get(this.#componentIdx);
      if (flags !== undefined) { flags.value = value ? 1 : 0; }
    }
    
    errored() { return this.#errored !== null; }
    setErrored(err) {
      _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
      if (this.#errored) { return; }
      if (!err) {
        err = new Error('error elswehere (see other component instance error)')
        err.componentIdx = this.#componentIdx;
      }
      this.#errored = err;
    }
    
    markTrapped(err) {
      if (!(err instanceof WebAssemblyRuntimeError)) {
        return false;
      }
      _debugLog('[ComponentAsyncState#markTrapped()] component trapped', { err, componentIdx: this.#componentIdx });
      if (STORE_TRAP.error === null) { STORE_TRAP.error = err; }
      return true;
    }
    
    throwIfTrapped() {
      if (STORE_TRAP.error !== null) { throw STORE_TRAP.error; }
    }
    
    callingSyncImport(val) {
      if (val === undefined) { return this.#callingAsyncImport; }
      if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
      const prev = this.#callingAsyncImport;
      this.#callingAsyncImport = val;
      if (prev === true && this.#callingAsyncImport === false) {
        this.#notifySyncImportEnd();
      }
    }
    
    #notifySyncImportEnd() {
      const existing = this.#syncImportWait;
      this.#syncImportWait = promiseWithResolvers();
      existing.resolve();
    }
    
    async waitForSyncImportCallEnd() {
      await this.#syncImportWait.promise;
    }
    
    setBackpressure(v) {
      this.#backpressure = v;
      return this.#backpressure
    }
    getBackpressure() { return this.#backpressure; }
    
    incrementBackpressure() {
      const current = this.#backpressure;
      if (current < 0 || current > 2**16) {
        throw new Error(`invalid current backpressure value [${current}]`);
      }
      const newValue = this.getBackpressure() + 1;
      if (newValue >= 2**16) {
        throw new Error(`invalid new backpressure value [${newValue}], overflow`);
      }
      return this.setBackpressure(newValue);
    }
    
    decrementBackpressure() {
      const current = this.#backpressure;
      if (current < 0 || current > 2**16) {
        throw new Error(`invalid current backpressure value [${current}]`);
      }
      const newValue = Math.max(0, current - 1);
      if (newValue < 0) {
        throw new Error(`invalid new backpressure value [${newValue}], underflow`);
      }
      return this.setBackpressure(newValue);
    }
    hasBackpressure() { return this.#backpressure > 0; }
    
    waitForBackpressure() {
      let backpressureCleared = false;
      const cstate = this;
      cstate.addBackpressureWaiter();
      const handlerID = this.registerHandler({
        event: 'backpressure-change',
        fn: (bp) => {
          if (bp === 0) {
            cstate.removeHandler(handlerID);
            backpressureCleared = true;
          }
        }
      });
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          if (backpressureCleared) { return; }
          clearInterval(interval);
          cstate.removeBackpressureWaiter();
          resolve(null);
        }, 0);
      });
    }
    
    registerHandler(args) {
      const { event, fn } = args;
      if (!event) { throw new Error("missing handler event"); }
      if (!fn) { throw new Error("missing handler fn"); }
      
      if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
        throw new Error(`unrecognized event handler [${event}]`);
      }
      
      const handlerID = this.#nextHandlerID++;
      let handlers = this.#handlerMap.get(event);
      if (!handlers) {
        handlers = [];
        this.#handlerMap.set(event, handlers)
      }
      
      handlers.push({ id: handlerID, fn, event });
      return handlerID;
    }
    
    removeHandler(args) {
      const { event, handlerID } = args;
      const registeredHandlers = this.#handlerMap.get(event);
      if (!registeredHandlers) { return; }
      const found = registeredHandlers.find(h => h.id === handlerID);
      if (!found) { return; }
      this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
    }
    
    getBackpressureWaiters() { return this.#backpressureWaiters; }
    addBackpressureWaiter() { this.#backpressureWaiters++; }
    removeBackpressureWaiter() {
      this.#backpressureWaiters--;
      if (this.#backpressureWaiters < 0) {
        throw new Error("unexepctedly negative number of backpressure waiters");
      }
    }
    
    // The per-slice mutual-exclusion lock for guest execution in this
    // component instance. Guest slices (callback invocations and
    // sync-lifted bodies) must be atomic per component even across the
    // JSPI suspensions jco introduces for host imports: wit-bindgen's
    // executors publish per-task state in single linear-memory cells
    // (the wasip3-task pointer, context-local storage discipline) that
    // an interleaved slice of the same component corrupts
    //
    // The lock is *owned*: acquisition records the holder task and
    // release is a no-op for anyone else, so a task exiting can no
    // longer drop a hold it does not own (blind acquire/release-any
    // was the previous discipline). Contended acquisition queues
    // FIFO; release hands the lock to the next waiter directly.
    isExclusivelyLocked() { return this.#lockHolderTaskID !== null; }
    exclusivelyLockedBy(taskID) { return this.#lockHolderTaskID === taskID; }
    
    exclusiveLock(taskID) {
      _debugLog('[ComponentAsyncState#exclusiveLock()]', {
        holder: this.#lockHolderTaskID,
        requester: taskID,
        componentIdx: this.#componentIdx,
      });
      if (taskID === undefined || taskID === null) {
        throw new Error('exclusive lock requires the acquiring task id');
      }
      if (this.#lockHolderTaskID !== null) {
        throw new Error(`component [${this.#componentIdx}] exclusive lock held by task [${this.#lockHolderTaskID}], requested by [${taskID}]`);
      }
      this.#lockHolderTaskID = taskID;
    }
    
    // Awaitable acquisition: takes the lock immediately when free,
    // otherwise queues FIFO behind the current holder and earlier
    // waiters. The resolved promise implies ownership.
    async acquireExclusiveLock(taskID) {
      if (taskID === undefined || taskID === null) {
        throw new Error('exclusive lock requires the acquiring task id');
      }
      if (this.#lockHolderTaskID === null) {
        this.#lockHolderTaskID = taskID;
        _debugLog('[ComponentAsyncState#acquireExclusiveLock()] acquired', {
          holder: taskID,
          componentIdx: this.#componentIdx,
        });
        return;
      }
      if (this.#lockHolderTaskID === taskID) {
        throw new Error(`task [${taskID}] already holds the lock for component [${this.#componentIdx}]`);
      }
      _debugLog('[ComponentAsyncState#acquireExclusiveLock()] waiting', {
        holder: this.#lockHolderTaskID,
        requester: taskID,
        componentIdx: this.#componentIdx,
        queued: this.#lockWaiters.length,
      });
      await new Promise((resolve) => {
        this.#lockWaiters.push({ taskID, resolve });
      });
    }
    
    exclusiveRelease(taskID) {
      _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
        holder: this.#lockHolderTaskID,
        releaser: taskID,
        componentIdx: this.#componentIdx,
      });
      if (this.#lockHolderTaskID !== taskID) {
        // Ownerless releases were the historical behavior; a foreign
        // release now leaves the hold intact
        _debugLog('[ComponentAsyncState#exclusiveRelease()] ignoring foreign release', {
          holder: this.#lockHolderTaskID,
          releaser: taskID,
          componentIdx: this.#componentIdx,
        });
        return false;
      }
      
      // Make the release observable before handing the lock to the next
      // asynchronous guest slice.
      //
      // Release handlers may expose a lifted value whose consumer immediately
      // performs a synchronous call on the same component; that call must run
      // while the instance is genuinely unlocked, not via enterSync's
      // lock-free fallback code.
      this.#lockHolderTaskID = null;
      
      this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
      for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
        try {
          this.#onExclusiveReleaseHandlers[idx] = null;
          f();
        } catch (err) {
          _debugLog("error while executing handler for next exclusive release", err);
          throw err;
        }
      }
      this.#scheduleLockHandoff();
      return true;
    }
    
    #scheduleLockHandoff() {
      if (this.#lockHandoffScheduled || this.#lockWaiters.length === 0) { return; }
      this.#lockHandoffScheduled = true;
      queueMicrotask(() => {
        this.#lockHandoffScheduled = false;
        // A synchronous call triggered by a release handler gets the
        // first opportunity to use the unlocked component.
        //
        // Its release will leave this queued handoff in place.
        if (this.#lockHolderTaskID !== null) {
          this.#scheduleLockHandoff();
          return;
        }
        const next = this.#lockWaiters.shift();
        if (!next) { return; }
        this.#lockHolderTaskID = next.taskID;
        next.resolve();
      });
    }
    
    onNextExclusiveRelease(fn) {
      _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
      this.#onExclusiveReleaseHandlers.push(fn);
    }
    
    async waitForExclusiveRelease() {
      while (this.isExclusivelyLocked()) {
        await new Promise(resolve => this.onNextExclusiveRelease(resolve));
      }
    }
    
    #getSuspendedTaskMeta(taskID) {
      return this.#suspendedTasksByTaskID.get(taskID);
    }
    
    #removeSuspendedTaskMeta(taskID) {
      _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
        taskID,
        componentIdx: this.#componentIdx,
      });
      const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
      const meta = this.#suspendedTasksByTaskID.get(taskID);
      this.#suspendedTaskIDs[idx] = null;
      this.#suspendedTasksByTaskID.delete(taskID);
      return meta;
    }
    
    #addSuspendedTaskMeta(meta) {
      if (!meta) { throw new Error('missing task meta'); }
      const taskID = meta.taskID;
      this.#suspendedTasksByTaskID.set(taskID, meta);
      this.#suspendedTaskIDs.push(taskID);
      if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
        this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
      }
    }
    
    // TODO(threads): readyFn is normally on the thread
    suspendTask(args) {
      const { task, readyFn } = args;
      const taskID = task.id();
      const componentIdx = task.componentIdx();
      _debugLog('[ComponentAsyncState#suspendTask()]', {
        taskID,
        componentIdx: this.#componentIdx,
        taskEntryFnName: task.entryFnName(),
        subtask: task.getParentSubtask(),
      });
      
      if (componentIdx !== this.#componentIdx) {
        throw new Error('assert: task component idx should match async state');
      }
      
      if (this.#getSuspendedTaskMeta(taskID)) {
        throw new Error(`task [${taskID}] already suspended`);
      }
      
      const { promise, resolve, reject } = promiseWithResolvers();
      this.#addSuspendedTaskMeta({
        task,
        taskID,
        readyFn,
        resume: () => {
          _debugLog('[ComponentAsyncState] resuming suspended task', {
            taskID,
            componentIdx: this.#componentIdx,
          });
          // TODO(threads): it's thread cancellation we should be checking for below, not task
          resolve(!task.isCancelled());
        },
      });
      
      this.runTickLoop();
      
      return promise;
    }
    
    resumeTaskByID(taskID) {
      const meta = this.#removeSuspendedTaskMeta(taskID);
      if (!meta) { return; }
      if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
      meta.resume();
    }
    
    async runTickLoop() {
      if (this.#tickLoop !== null) { return; }
      this.#tickLoop = 1;
      setTimeout(async () => {
        let result = this.tick();
        while (result !== ComponentAsyncState.TickResult.DONE) {
          // After resuming a task, re-tick as soon as the resumed
          // slice's microtask continuations have drained (timeout 0)
          // so queued sibling resumptions aren't charged the idle
          // polling interval; otherwise poll at the idle cadence.
          const delay = result === ComponentAsyncState.TickResult.RESUMED ? 0 : 10;
          await new Promise((resolve) => setTimeout(resolve, delay));
          result = this.tick();
        }
        this.#tickLoop = null;
      }, 10);
    }
    
    tick() {
      // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
      
      const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
      for (const taskID of resumableTasks) {
        const meta = this.#suspendedTasksByTaskID.get(taskID);
        if (!meta || !meta.readyFn) {
          throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
        }
        
        // If the task failed via any means, allow the task to resume because
        // it's been cancelled -- the callback should immediately exit as well
        if (meta.task.isRejected()) {
          _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
          this.resumeTaskByID(taskID);
          return ComponentAsyncState.TickResult.RESUMED;
        }
        
        const isReady = meta.readyFn();
        if (!isReady) { continue; }
        
        _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        this.resumeTaskByID(taskID);
        
        // NOTE: during single-flight resumption, we should resume at most one task per
        // tick so that the resumed slice (a microtask continuation)
        // runs -- and its current-task register window opens and
        // closes -- before any sibling task of this component is
        // resumed.
        //
        // Resuming multiple suspended tasks in one synchronous
        // cascade interleaves their register save/restore windows
        // ([restoreA, restoreB, resumeA, resumeB]), re-entering wasm
        // with the register naming the wrong task, and the
        // 'known residual' of the JSPI current-task register
        // fix); with concurrent task lifetimes per component this
        // corrupts guest context-local storage.
        return ComponentAsyncState.TickResult.RESUMED;
      }
      
      const idle = this.#suspendedTaskIDs.filter(t => t !== null).length > 0;
      return idle
      ? ComponentAsyncState.TickResult.IDLE
      : ComponentAsyncState.TickResult.DONE;
    }
    
    createWaitable(args) {
      return new Waitable({ target: args?.target, });
    }
  }
  
  function getOrCreateAsyncState(componentIdx, init) {
    if (!ASYNC_STATE.has(componentIdx)) {
      const newState = new ComponentAsyncState({ componentIdx });
      ASYNC_STATE.set(componentIdx, newState);
    }
    return ASYNC_STATE.get(componentIdx);
  }
  const GLOBAL_COMPONENT_MEMORY_MAP = new Map();
  
  function lookupMemoriesForComponent(args) {
    const { componentIdx } = args ?? {};
    if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }
    
    const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!metas) { return []; }
    
    if (args.memoryIdx === undefined) {
      return Object.values(metas);
    }
    
    const meta = metas[args.memoryIdx];
    return meta?.memory;
  }
  
  class AsyncSubtask {
    static _ID = 0n;
    
    static State = {
      STARTING: 0,
      STARTED: 1,
      RETURNED: 2,
      CANCELLED_BEFORE_STARTED: 3,
      CANCELLED_BEFORE_RETURNED: 4,
    };
    
    #id;
    #state = AsyncSubtask.State.STARTING;
    #componentIdx;
    
    #parentTask;
    #childTask = null;
    
    #dropped = false;
    #cancelRequested = false;
    
    #memoryIdx = null;
    #lenders = null;
    
    #waitable = null;
    
    #callbackFn = null;
    #callbackFnName = null;
    
    #postReturnFn = null;
    #onProgressFn = null;
    #pendingEventFn = null;
    
    #callMetadata = {};
    
    #resolved = false;
    
    #onResolveHandlers = [];
    #onStartHandlers = [];
    
    #result = null;
    #resultSet = false;
    
    fnName;
    target;
    isAsync;
    isManualAsync;
    
    constructor(args) {
      if (typeof args.componentIdx !== 'number') {
        throw new Error('invalid componentIdx for subtask creation');
      }
      this.#componentIdx = args.componentIdx;
      
      this.#id = ++AsyncSubtask._ID;
      this.fnName = args.fnName;
      
      if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
      this.#parentTask = args.parentTask;
      
      if (args.childTask) { this.#childTask = args.childTask; }
      
      if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }
      
      if (!args.waitable) { throw new Error("missing/invalid waitable"); }
      this.#waitable = args.waitable;
      
      if (args.callMetadata) { this.#callMetadata = args.callMetadata; }
      
      this.#lenders = [];
      this.target = args.target;
      this.isAsync = args.isAsync;
      this.isManualAsync = args.isManualAsync;
    }
    
    id() { return this.#id; }
    parentTaskID() { return this.#parentTask?.id(); }
    childTaskID() { return this.#childTask?.id(); }
    state() { return this.#state; }
    
    waitable() { return this.#waitable; }
    waitableRep() { return this.#waitable.idx(); }
    
    join() { return this.#waitable.join(...arguments); }
    getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
    hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
    setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }
    
    setTarget(tgt) { this.target = tgt; }
    
    getResult() {
      if (!this.#resultSet) { throw new Error("subtask result has not been set") }
      return this.#result;
    }
    setResult(v) {
      if (this.#resultSet) { throw new Error("subtask result has already been set"); }
      this.#result = v;
      this.#resultSet = true;
    }
    
    componentIdx() { return this.#componentIdx; }
    
    setChildTask(t) {
      if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
      if (this.#childTask) { throw new Error('child task is already set on subtask'); }
      if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
      this.#childTask = t;
    }
    getChildTask(t) { return this.#childTask; }
    
    getParentTask() { return this.#parentTask; }
    
    setCallbackFn(f, name) {
      if (!f) { return; }
      if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    
    getCallbackFnName() {
      if (!this.#callbackFn) { return undefined; }
      return this.#callbackFn.name;
    }
    
    setPostReturnFn(f) {
      if (!f) { return; }
      if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
      this.#postReturnFn = f;
    }
    
    setOnProgressFn(f) {
      if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
      this.#onProgressFn = f;
    }
    
    isNotStarted() {
      return this.#state == AsyncSubtask.State.STARTING;
    }
    
    cancellationRequested() { return this.#cancelRequested; }
    
    // Request cooperative cancellation of this subtask, on behalf of the
    // supertask (i.e. `canon subtask.cancel`).
    //
    // If the callee is another guest task, the request is delivered to it and
    // the callee confirms via `task.cancel` (or still resolves via `task.return`).
    //
    // If the callee is a host function there is (currently) no host-side
    // cancellation hook, so the pending call is treated as immediately
    // cancelled -- consistent with hosts being expected to resolve
    // cancellation promptly -- and any later host resolution is discarded
    // (see `AsyncTask#onResolve`).
    requestCancellation() {
      _debugLog('[AsyncSubtask#requestCancellation()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        state: this.#state,
        childTaskID: this.childTaskID(),
        fnName: this.fnName,
      });
      if (this.#cancelRequested) {
        throw new Error('cancellation has already been requested for this subtask');
      }
      this.#cancelRequested = true;
      
      if (this.#resolved) { return; }
      
      if (this.#childTask) {
        this.#childTask.requestCancellation();
        return;
      }
      
      this.onResolve(null);
    }
    
    registerOnStartHandler(f) {
      this.#onStartHandlers.push(f);
    }
    
    onStart(args) {
      _debugLog('[AsyncSubtask#onStart()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        parentTaskID: this.parentTaskID(),
        fnName: this.fnName,
        args,
      });
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      this.#state = AsyncSubtask.State.STARTED;
      
      let result;
      
      // If we have been provided a helper start function as a result of
      // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
      // be performed for us.
      //
      // See also documentation on `HostIntrinsic::PrepareCall`
      //
      if (this.#callMetadata.startFn) {
        result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
      }
      
      return result;
    }
    
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    reject(subtaskErr) {
      if (this.#resolved) { return; }
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      if (this.#state === AsyncSubtask.State.STARTING) {
        this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
      } else if (this.#state === AsyncSubtask.State.STARTED) {
        this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
      } else {
        throw new Error('cannot reject a completed subtask');
      }
      
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
      this.#parentTask.reject(subtaskErr);
    }
    
    onResolve(subtaskValue) {
      _debugLog('[AsyncSubtask#onResolve()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        isAsync: this.isAsync,
        childTaskID: this.childTaskID(),
        parentTaskID: this.parentTaskID(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        fnName: this.fnName,
      });
      
      if (this.#resolved) {
        throw new Error('subtask has already been resolved');
      }
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      if (subtaskValue === null && this.#cancelRequested) {
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before cancellation');
          }
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        }
      } else {
        if (this.#state !== AsyncSubtask.State.STARTED) {
          throw new Error('resolved subtask must have been started before completion');
        }
        this.#state = AsyncSubtask.State.RETURNED;
      }
      
      this.setResult(subtaskValue);
      
      for (const f of this.#onResolveHandlers) {
        try {
          f(subtaskValue);
        } catch (err) {
          console.error("error during subtask resolve handler", err);
          throw err;
        }
      }
      
      const callMetadata = this.getCallMetadata();
      
      // TODO(fix): we should be able to easily have the caller's meomry
      // to lower into here, but it's not present in PrepareCall
      const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
      // NOTE: cancelled resolutions carry no value, so nothing is lowered
      const returned = this.#state === AsyncSubtask.State.RETURNED;
      if (returned && callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
        const { resultPtr, realloc } = callMetadata;
        const lowers = callMetadata.lowers; // may have been updated in task.return of the child
        if (lowers && lowers.length > 0) {
          lowers[0]({
            componentIdx: this.#componentIdx,
            memory,
            realloc,
            vals: [subtaskValue],
            storagePtr: resultPtr,
            stringEncoding: callMetadata.stringEncoding,
          });
        }
      }
      
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
      
      if (!this.isAsync) {
        this.deliverResolve();
        const rep = this.waitableRep();
        if (rep) {
          try {
            const removed = this.#getComponentState().handles.remove(rep);
            if (removed !== this) {
              throw new Error("unexpectedly received non-self Subtask from handle removal");
            }
            this.drop();
          } catch (err) {
            _debugLog('[AsyncSubtask#onResolve()] failed to remove subtask after sync subtask completion', err);
          }
        }
      }
    }
    
    getStateNumber() { return this.#state; }
    isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }
    
    getCallMetadata() { return this.#callMetadata; }
    
    isResolved() {
      if (this.#state === AsyncSubtask.State.STARTING
      || this.#state === AsyncSubtask.State.STARTED) {
        return false;
      }
      if (this.#state === AsyncSubtask.State.RETURNED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
        return true;
      }
      throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
    }
    
    addLender(handle) {
      _debugLog('[AsyncSubtask#addLender()] args', { handle });
      if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }
      
      if (this.#lenders.length === 0 || this.isResolved()) {
        throw new Error('subtask has no lendors or has already been resolved');
      }
      
      handle.lends++;
      this.#lenders.push(handle);
    }
    
    deliverResolve() {
      _debugLog('[AsyncSubtask#deliverResolve()] args', {
        lenders: this.#lenders,
        parentTaskID: this.parentTaskID(),
        subtaskID: this.#id,
        childTaskID: this.childTaskID(),
        resolved: this.isResolved(),
        resolveDelivered: this.resolveDelivered(),
      });
      
      const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
      if (cannotDeliverResolve) {
        throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
      }
      
      for (const lender of this.#lenders) {
        lender.lends--;
      }
      
      this.#lenders = null;
    }
    
    resolveDelivered() {
      _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
      if (this.#lenders === null && !this.isResolved()) {
        throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
      }
      return this.#lenders === null;
    }
    
    drop() {
      _debugLog('[AsyncSubtask#drop()] args', {
        componentIdx: this.#componentIdx,
        parentTaskID: this.#parentTask?.id(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        childTaskID: this.#childTask?.id(),
        childTaskFnName: this.#childTask?.entryFnName(),
        subtaskFnName: this.fnName,
      });
      if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
      if (!this.resolveDelivered()) {
        throw new Error('cannot drop subtask before resolve is delivered');
      }
      if (this.#waitable) { this.#waitable.drop() }
      this.#dropped = true;
    }
    
    #getComponentState() {
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error('invalid/missing async state for component [' + componentIdx + ']');
      }
      return state;
    }
    
    getWaitableHandleIdx() {
      _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
      if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
      return this.waitableRep();
    }
  }
  
  class FutureValue {
    #start;
    #settled;
    #hideThen = 0;
    #thenFn;
    
    constructor(start) {
      if (typeof start !== 'function') {
        throw new TypeError('future start operation must be a function');
      }
      this.#start = start;
      this.#thenFn = this.#then.bind(this);
    }
    
    get then() {
      return this.#hideThen === 0 ? this.#thenFn : undefined;
    }
    
    #read() {
      if (!this.#settled) {
        // The start operation resolves to a non-thenable box so a
        // future-valued payload cannot be assimilated by this Promise.
        this.#settled = Promise.resolve().then(this.#start);
      }
      return this.#settled;
    }
    
    resolveAsValue(resolve) {
      this.#hideThen++;
      try {
        resolve(this);
      } finally {
        this.#hideThen--;
      }
    }
    
    #deliver(resolve, value) {
      if (value instanceof FutureValue) {
        // Promise resolution reads `then` synchronously. Hide it only
        // for that lookup so resolving this layer yields the inner
        // FutureValue instead of recursively awaiting it.
        value.resolveAsValue(resolve);
        return;
      }
      resolve(value);
    }
    
    #then(resolve, reject) {
      return this.#read().then(
      box => this.#deliver(resolve, box.value),
      reject,
      );
    }
  }
  const ASYNC_DETERMINISM = 'random';
  const _coinFlip = () => { return Math.random() > 0.5; };
  
  const ASYNC_EVENT_CODE = {
    NONE: 0,
    SUBTASK: 1,
    STREAM_READ: 2,
    STREAM_WRITE: 3,
    FUTURE_READ: 4,
    FUTURE_WRITE: 5,
    TASK_CANCELLED: 6,
  };
  const CURRENT_TASK_META = {};
  
  function _withGlobalCurrentTaskMeta(args) {
    _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    const { taskID, componentIdx, fn } = args;
    const previous = CURRENT_TASK_META[componentIdx] ?? null;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return fn();
    } catch (err) {
      _debugLog("error while executing sync callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      // Synchronous wrappers can nest without any intervening JS
      // scheduling. Restore the caller rather than clearing it so
      // helper core exports (for example fused return adapters) can
      // temporarily run under a different task of the same component.
      CURRENT_TASK_META[componentIdx] = previous;
    }
  }
  
  async function _withGlobalCurrentTaskMetaAsync(args) {
    _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return await fn();
    } catch (err) {
      _debugLog("error while executing async callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  class AsyncTask {
    static _ID = 0n;
    
    static State = {
      INITIAL: 'initial',
      CANCELLED: 'cancelled',
      CANCEL_PENDING: 'cancel-pending',
      CANCEL_DELIVERED: 'cancel-delivered',
      RESOLVED: 'resolved',
    }
    
    static BlockResult = {
      CANCELLED: 'block.cancelled',
      NOT_CANCELLED: 'block.not-cancelled',
    }
    
    #id;
    #componentIdx;
    #state;
    #isAsync;
    #isManualAsync;
    #callingWasmExport = true;
    #lockFreeEntry = false;
    #preserveFutureResult;
    #entryFnName = null;
    
    #onResolveHandlers = [];
    #completionPromise = null;
    #rejected = false;
    
    #exitPromise = null;
    #onExitHandlers = [];
    
    #memoryIdx = null;
    #memory = null;
    
    #callbackFn = null;
    #callbackFnName = null;
    
    #postReturnFn = null;
    
    #getCalleeParamsFn = null;
    
    #stringEncoding = null;
    
    #parentSubtask = null;
    
    #errHandling;
    
    #backpressurePromise;
    #backpressureWaiters = 0n;
    
    #returnLowerFns = null;
    
    #subtasks = [];
    
    #entered = false;
    #exited = false;
    #errored = null;
    
    cancelled = false;
    cancelRequested = false;
    alwaysTaskReturn = false;
    
    returnCalls =  0;
    storage = [0, 0];
    borrowedHandles = {};
    
    tmpRetI64HighBits = 0|0;
    
    constructor(opts) {
      this.#id = ++AsyncTask._ID;
      
      if (opts?.componentIdx === undefined) {
        throw new TypeError('missing component id during task creation');
      }
      this.#componentIdx = opts.componentIdx;
      
      this.#state = AsyncTask.State.INITIAL;
      this.#isAsync = opts?.isAsync ?? false;
      this.#isManualAsync = opts?.isManualAsync ?? false;
      this.#preserveFutureResult = opts?.preserveFutureResult ?? false;
      this.#entryFnName = opts.entryFnName;
      // Tasks that execute guest slices (export calls, fused
      // callees) default to true; import-handler tasks pass false
      // explicitly (they run host code nested inside the caller's
      // already-locked slice).
      this.#callingWasmExport = opts?.callingWasmExport !== false;
      
      const {
        promise: completionPromise,
        resolve: resolveCompletionPromise,
        reject: rejectCompletionPromise,
      } = promiseWithResolvers();
      this.#completionPromise = completionPromise;
      // A nested rejection can reach the root task while its Wasm
      // entrypoint is still suspended, before the export wrapper awaits
      // this promise. Mark it handled immediately while preserving the
      // original rejected promise for the eventual caller.
      completionPromise.catch(() => {});
      
      this.#onResolveHandlers.push((results) => {
        if (this.#parentSubtask !== null) { return; }
        if (!this.#isAsync) { return; }
        
        if (this.#errored !== null) {
          rejectCompletionPromise(this.#errored);
          return;
        } else if (this.#rejected) {
          rejectCompletionPromise(results);
          return;
        }
        
        if (this.#preserveFutureResult && results instanceof FutureValue) {
          results.resolveAsValue(resolveCompletionPromise);
        } else {
          resolveCompletionPromise(results);
        }
      });
      
      const {
        promise: exitPromise,
        resolve: resolveExitPromise,
        reject: rejectExitPromise,
      } = promiseWithResolvers();
      this.#exitPromise = exitPromise;
      
      this.#onExitHandlers.push(() => {
        resolveExitPromise();
      });
      
      if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
      if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
      
      if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
      
      if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
      
      if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
      
      
      if (opts.errHandling) { this.#errHandling = opts.errHandling; }
    }
    
    taskState() { return this.#state; }
    id() { return this.#id; }
    componentIdx() { return this.#componentIdx; }
    entryFnName() { return this.#entryFnName; }
    
    completionPromise() { return this.#completionPromise; }
    exitPromise() { return this.#exitPromise; }
    
    isAsync() { return this.#isAsync; }
    isSync() { return !this.isAsync(); }
    
    getErrHandling() { return this.#errHandling; }
    
    hasCallback() { return this.#callbackFn !== null; }
    
    getReturnMemoryIdx() { return this.#memoryIdx; }
    setReturnMemoryIdx(idx) {
      if (idx === null) { return; }
      this.#memoryIdx = idx;
    }
    
    getReturnMemory() { return this.#memory; }
    setReturnMemory(m) {
      if (m === null) { return; }
      this.#memory = m;
    }
    
    setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
    getReturnLowerFns() { return this.#returnLowerFns; }
    
    setParentSubtask(subtask) {
      if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
      if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
      this.#parentSubtask = subtask;
    }
    
    getParentSubtask() { return this.#parentSubtask; }
    
    // TODO(threads): this is very inefficient, we can pass along a root task,
    // and ideally do not need this once thread support is in place
    getRootTask() {
      let currentSubtask = this.getParentSubtask();
      let task = this;
      while (currentSubtask) {
        task = currentSubtask.getParentTask();
        currentSubtask = task.getParentSubtask();
      }
      return task;
    }
    
    setPostReturnFn(f) {
      if (!f) { return; }
      if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
      this.#postReturnFn = f;
    }
    
    setCallbackFn(f, name) {
      if (!f) { return; }
      if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    
    getCallbackFnName() {
      if (!this.#callbackFnName) { return undefined; }
      return this.#callbackFnName;
    }
    
    async runCallbackFn(...args) {
      if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
      return _withGlobalCurrentTaskMetaAsync({
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        fn: () => { return this.#callbackFn.apply(null, args); }
      });
    }
    
    getCalleeParams() {
      if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
      return this.#getCalleeParamsFn();
    }
    
    mayBlock() { return this.isAsync() || this.isResolvedState() }
    
    mayEnter(task) {
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (cstate.hasBackpressure()) {
        _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
        return false;
      }
      if (!cstate.callingSyncImport()) {
        _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
        return false;
      }
      const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
      if (!callingSyncExportWithSyncPending) {
        _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
        return false;
      }
      return true;
    }
    
    enterSync() {
      if (this.needsExclusiveLock()) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (!cstate.isExclusivelyLocked()) {
          cstate.exclusiveLock(this.#id);
        } else {
          // A host-called sync export arriving while another
          // task's slice holds the lock: synchronous entry
          // cannot wait, and historically this entry silently
          // stole the hold. Run without the lock instead --
          // the holder's bookkeeping stays intact and its
          // release still pairs
          this.#lockFreeEntry = true;
          _debugLog('[AsyncTask#enterSync()] entering without exclusive lock', {
            taskID: this.#id,
            componentIdx: this.#componentIdx,
          });
        }
      }
      return true;
    }
    
    async enter(opts) {
      _debugLog('[AsyncTask#enter()] args', {
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        subtaskID: this.getParentSubtask()?.id(),
        args: opts,
        entryFnName: this.#entryFnName,
      });
      
      if (this.#entered) {
        throw new Error(`task with ID [${this.#id}] should not be entered twice`);
      }
      
      // If cancellation was requested before the task was entered, resolve
      // as cancelled without ever running guest code
      if (this.deliverPendingCancel({ cancellable: true })) {
        this.cancel();
        return false;
      }
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      
      if (opts?.isHost) {
        this.#entered = true;
        return this.#entered;
      }
      
      // NOTE: concurrent task lifetimes within one component instance are
      // permitted by the Component Model: entry is governed by the
      // backpressure and exclusive-lock checks below (the lock is held per
      // execution slice, not for the task's lifetime).
      //
      // Serializing entire task lifetimes here (the former "execution slot" queue)
      // deadlocks pipelines where a parked long-lived task's progress depends on a
      // later entry into the same component.
      
      // If a task is synchronous then we can avoid component-relevant
      // tracking and immediately enter.
      if (this.isSync()) {
        this.#entered = true;
        
        // TODO(breaking): remove once manually-specifying async fns is removed
        // It is currently possible for an actually sync export to be specified
        // as async via JSPI
        if (this.#isManualAsync) {
          if (this.needsExclusiveLock()) { await cstate.acquireExclusiveLock(this.#id); }
        }
        
        return this.#entered;
      }
      
      // Perform intial backpressure check
      if (cstate.hasBackpressure()) {
        cstate.addBackpressureWaiter();
        
        const result = await this.waitUntil({
          readyFn: () => {
            return !cstate.hasBackpressure();
          },
          cancellable: true,
        });
        
        cstate.removeBackpressureWaiter();
        
        if (result === AsyncTask.BlockResult.CANCELLED) {
          this.cancel();
          return false;
        }
      }
      
      // Acquire the per-slice exclusive lock (FIFO-queued when
      // contended); the first slice runs under this hold and the
      // driver loop releases/re-acquires it per slice thereafter.
      if (this.needsExclusiveLock()) {
        await cstate.acquireExclusiveLock(this.#id);
      }
      
      this.#entered = true;
      return this.#entered;
    }
    
    isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
    isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
    isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
    isExited() { return this.#exited; }
    
    async waitUntil(opts) {
      const { readyFn, cancellable } = opts;
      _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });
      
      // TODO(fix): check for cancel
      // TODO(fix): determinism
      // TODO(threads): add this thread to waiting list
      
      const keepGoing = await this.suspendUntil({
        readyFn,
        cancellable,
      });
      
      return keepGoing;
    }
    
    async yieldUntil(opts) {
      const { readyFn, cancellable } = opts;
      _debugLog('[AsyncTask#yieldUntil()]', {
        taskID: this.#id,
        args: {
          cancellable,
        },
        componentIdx: this.#componentIdx,
      });
      
      const keepGoing = await this.suspendUntil({ readyFn, cancellable });
      if (keepGoing) {
        return {
          code: ASYNC_EVENT_CODE.NONE,
          payload0: 0,
          payload1: 0,
        };
      }
      
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload0: 0,
        payload1: 0,
      };
    }
    
    async suspendUntil(opts) {
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#suspendUntil()] args', {
        taskID: this.#id,
        args: {
          cancellable,
        },
        componentIdx: this.#componentIdx,
      });
      
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }
      
      const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
      return completed;
    }
    
    // TODO(threads): equivalent to thread.suspend_until()
    async immediateSuspendUntil(opts) {
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
        args: {
          cancellable,
          readyFn,
        },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });
      
      const ready = readyFn();
      if (ready && ASYNC_DETERMINISM === 'random') {
        const coinFlip = _coinFlip();
        if (coinFlip) { return true }
      }
      
      const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
      return keepGoing;
    }
    
    async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
    // TODO(threads): store readyFn on the thread
    const { cancellable, readyFn } = opts;
    _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
    
    const pendingCancelled = this.deliverPendingCancel({ cancellable });
    if (pendingCancelled) { return false; }
    
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    const keepGoing = await cstate.suspendTask({
      task: this,
      readyFn: () => {
        // A pending cancellation request wakes cancellable waits
        if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
          return true;
        }
        return readyFn();
      },
    });
    if (keepGoing && this.deliverPendingCancel({ cancellable })) { return false; }
    return keepGoing;
  }
  
  deliverPendingCancel(opts) {
    const { cancellable } = opts;
    _debugLog('[AsyncTask#deliverPendingCancel()]', {
      args: { cancellable },
      taskID: this.#id,
      componentIdx: this.#componentIdx,
    });
    
    if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
      this.#state = AsyncTask.State.CANCEL_DELIVERED;
      return true;
    }
    
    return false;
  }
  
  isCancelled() { return this.cancelled }
  
  // Request cooperative cancellation of this task, called on behalf of a
  // supertask performing `subtask.cancel` on the subtask this task backs.
  //
  // The request is delivered at this task's next cancellable wait
  // (see suspendUntil/immediateSuspend), at which point the task is
  // expected to acknowledge via `task.cancel` or still resolve via
  // `task.return`.
  requestCancellation() {
    _debugLog('[AsyncTask#requestCancellation()] args', {
      taskID: this.#id,
      componentIdx: this.#componentIdx,
      state: this.#state,
    });
    if (this.isResolvedState() || this.cancelRequested) { return; }
    this.cancelRequested = true;
    if (this.#state === AsyncTask.State.INITIAL) {
      this.#state = AsyncTask.State.CANCEL_PENDING;
    }
    // Nudge the component's tick loop so that any suspended cancellable
    // wait observes the pending cancellation promptly
    getOrCreateAsyncState(this.#componentIdx).runTickLoop();
  }
  
  cancel(args) {
    _debugLog('[AsyncTask#cancel()] args', { });
    if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
      throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
    }
    if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
    this.cancelled = true;
    // Cancelled tasks resolve with no value (spec: `Task.cancel` calls
    // `on_resolve(None)`); an explicit error is only present on the
    // host-driven rejection path (see `reject()`).
    this.onResolve(args?.error ?? null);
    this.#state = AsyncTask.State.RESOLVED;
  }
  
  onResolve(taskValue) {
    const handlers = this.#onResolveHandlers;
    this.#onResolveHandlers = [];
    for (const f of handlers) {
      try {
        f(taskValue);
      } catch (err) {
        _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
        throw err;
      }
    }
    
    // Rejections are control-flow failures, not canonical ABI results.
    // Propagate them through the subtask chain without running return
    // lowering or post-return hooks for a successful result.
    if (this.#rejected) {
      this.#parentSubtask?.reject(taskValue);
      return;
    }
    
    // NOTE: if the parent subtask has already been resolved (e.g. it was
    // cancelled via `subtask.cancel` while this task was still pending),
    // this task's resolution must be discarded rather than delivered.
    const parentSubtaskPending = this.#parentSubtask && !this.#parentSubtask.isResolved();
    
    if (parentSubtaskPending) {
      const meta = this.#parentSubtask.getCallMetadata();
      // Run the rturn fn if it has not already been called -- this *should* have happened in
      // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
      // which goes through prepare + async-start-call)
      if (meta.returnFn && !meta.returnFnCalled) {
        _debugLog('[AsyncTask#onResolve()] running returnFn', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
          subtaskID: this.#parentSubtask.id(),
        });
        const callerTask = this.#parentSubtask.getParentTask();
        _withGlobalCurrentTaskMeta({
          taskID: callerTask.id(),
          componentIdx: callerTask.componentIdx(),
          fn: () => meta.returnFn.apply(null, [taskValue, meta.resultPtr]),
        });
        meta.returnFnCalled = true;
      }
    }
    
    if (this.#postReturnFn) {
      _debugLog('[AsyncTask#onResolve()] running post return ', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });
      try {
        _withGlobalCurrentTaskMeta({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => this.#postReturnFn(taskValue),
        });
      } catch (err) {
        _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
        throw err;
      }
    }
    
    if (parentSubtaskPending) {
      this.#parentSubtask.onResolve(taskValue);
    }
  }
  
  registerOnResolveHandler(f) {
    this.#onResolveHandlers.push(f);
  }
  
  isRejected() { return this.#rejected; }
  
  isErrored() { return this.#errored; }
  setErrored(err) { this.#errored = err; }
  
  reject(taskErr) {
    _debugLog('[AsyncTask#reject()] args', {
      componentIdx: this.#componentIdx,
      taskID: this.#id,
      parentSubtask: this.#parentSubtask,
      parentSubtaskID: this.#parentSubtask?.id(),
      entryFnName: this.entryFnName(),
      callbackFnName: this.#callbackFnName,
      errMsg: taskErr.message,
    });
    
    if (this.isResolvedState() || this.#rejected) { return; }
    
    this.#rejected = true;
    this.cancelRequested = true;
    this.#state = AsyncTask.State.CANCEL_PENDING;
    const cancelled = this.deliverPendingCancel({ cancellable: true });
    
    // TODO: do cleanup here to reset the machinery so we can run again?
    
    this.cancel({ error: taskErr });
  }
  
  resolve(results) {
    _debugLog('[AsyncTask#resolve()] args', {
      componentIdx: this.#componentIdx,
      taskID: this.#id,
      entryFnName: this.entryFnName(),
      callbackFnName: this.#callbackFnName,
    });
    
    if (this.#state === AsyncTask.State.RESOLVED) {
      throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
    }
    
    if (this.borrowedHandles.length > 0) {
      throw new Error('task still has borrow handles');
    }
    
    this.#state = AsyncTask.State.RESOLVED;
    
    switch (results.length) {
      case 0:
      this.onResolve(undefined);
      break;
      case 1:
      this.onResolve(results[0]);
      break;
      default:
      _debugLog('[AsyncTask#resolve()] unexpected number of results', {
        componentIdx: this.#componentIdx,
        results,
        taskID: this.#id,
        subtaskID: this.#parentSubtask?.id(),
        entryFnName: this.#entryFnName,
        callbackFnName: this.#callbackFnName,
      });
      throw new Error('unexpected number of results');
    }
  }
  
  exit(args) {
    _debugLog('[AsyncTask#exit()]', {
      componentIdx: this.#componentIdx,
      taskID: this.#id,
    });
    
    if (this.#exited)  { throw new Error("task has already exited"); }
    
    if (this.#state !== AsyncTask.State.RESOLVED) {
      throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
    }
    
    if (this.borrowedHandles > 0) {
      throw new Error('task [${this.#id}] exited without clearing borrowed handles');
    }
    
    const state = getOrCreateAsyncState(this.#componentIdx);
    if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
    
    // Exempt the host from exclusive lock check
    if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck && !this.#lockFreeEntry) {
      if (this.needsExclusiveLock() && !state.exclusivelyLockedBy(this.#id)) {
        throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked by it`);
      }
    }
    
    // Ownership-checked: releases only this task's own hold (a
    // task exiting while another task's slice holds the lock no
    // longer clears the foreign hold).
    state.exclusiveRelease(this.#id);
    
    for (const f of this.#onExitHandlers) {
      try {
        f();
      } catch (err) {
        console.error("error during task exit handler", err);
        throw err;
      }
    }
    
    this.#exited = true;
    clearCurrentTask(this.#componentIdx, this.id());
  }
  
  needsExclusiveLock() {
    // Host (-1) tasks model host-side import handling: there is no
    // guest linear memory or executor state to protect, and host
    // calls from unrelated guest components would contend spuriously.
    if (this.#componentIdx === -1) { return false; }
    // Import-handler tasks (CallInterface) run host code nested
    // inside the calling guest slice, which already holds the
    // lock; only tasks that execute guest slices need it.
    if (!this.#callingWasmExport) { return false; }
    return !this.#isAsync || this.hasCallback();
  }
  
  createSubtask(args) {
    _debugLog('[AsyncTask#createSubtask()] args', args);
    const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
    
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (!cstate) {
      throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
    }
    
    const waitable = new Waitable({
      componentIdx: this.#componentIdx,
      target: `subtask (internal ID [${this.#id}])`,
    });
    
    const newSubtask = new AsyncSubtask({
      componentIdx,
      childTask,
      parentTask: this,
      callMetadata,
      isAsync,
      isManualAsync,
      fnName,
      waitable,
    });
    this.#subtasks.push(newSubtask);
    newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
    waitable.setIdx(cstate.handles.insert(newSubtask));
    waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
    return newSubtask;
  }
  
  getLatestSubtask() {
    return this.#subtasks.at(-1);
  }
  
  getSubtaskByWaitableRep(rep) {
    if (rep === undefined) { throw new TypeError('missing rep'); }
    return this.#subtasks.find(s => s.waitableRep() === rep);
  }
  
  currentSubtask() {
    _debugLog('[AsyncTask#currentSubtask()]');
    if (this.#subtasks.length === 0) { return undefined; }
    return this.#subtasks.at(-1);
  }
  
  removeSubtask(subtask) {
    if (this.#subtasks.length === 0) {
      throw new Error('cannot end current subtask: no current subtask');
    }
    this.#subtasks = this.#subtasks.filter(t => t !== subtask);
    return subtask;
  }
}

function createNewCurrentTask(args) {
  _debugLog('[createNewCurrentTask()] args', args);
  const {
    componentIdx,
    isAsync,
    isManualAsync,
    preserveFutureResult,
    entryFnName,
    parentSubtaskID,
    callbackFnName,
    getCallbackFn,
    getParamsFn,
    stringEncoding,
    errHandling,
    getCalleeParamsFn,
    resultPtr,
    callingWasmExport,
  } = args;
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while starting task');
  }
  let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  const callbackFn = getCallbackFn ? getCallbackFn() : null;
  
  const newTask = new AsyncTask({
    componentIdx,
    isAsync,
    isManualAsync,
    preserveFutureResult,
    entryFnName,
    callbackFn,
    callbackFnName,
    stringEncoding,
    getCalleeParamsFn,
    resultPtr,
    errHandling,
    callingWasmExport,
  });
  
  const newTaskID = newTask.id();
  const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
  
  // NOTE: do not track host tasks
  ASYNC_CURRENT_TASK_IDS.push(newTaskID);
  ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
  
  if (!taskMetas) {
    taskMetas = [newTaskMeta];
    ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
  } else {
    taskMetas.push(newTaskMeta);
  }
  
  return [newTask, newTaskID];
}

function _getGlobalCurrentTaskMeta(componentIdx) {
  if (componentIdx === null || componentIdx === undefined) {
    throw new Error("missing/invalid component idx");
  }
  const v = CURRENT_TASK_META[componentIdx];
  if (v === undefined || v === null) {
    return undefined;
  }
  return { ...v };
}


function callResourceDestructor(args) {
  const { componentIdx, dtor, rep } = args;
  
  // A resource can be disposed re-entrantly while its component
  // already has a current task. In that case the destructor is part
  // of that task and must not replace its current-task register.
  if (_getGlobalCurrentTaskMeta(componentIdx)) {
    return dtor(rep);
  }
  
  const [task] = createNewCurrentTask({
    componentIdx,
    isAsync: false,
    callingWasmExport: true,
    entryFnName: '<resource-drop>',
  });
  task.enterSync();
  
  return _withGlobalCurrentTaskMeta({
    taskID: task.id(),
    componentIdx,
    fn: () => {
      try {
        const result = dtor(rep);
        task.resolve([]);
        task.exit();
        return result;
      } catch (err) {
        if (!task.isResolvedState()) {
          task.setErrored(err);
          task.reject(err);
        }
        if (!task.isExited()) {
          task.exit({ skipExclusiveLockCheck: true });
        }
        throw err;
      }
    },
  });
}


function getCurrentTask(componentIdx, taskID) {
  let usedGlobal = false;
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing component idx'); // TODO(fix)
    // componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
    // usedGlobal = true;
  }
  
  const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (taskMetas === undefined || taskMetas.length === 0) { return undefined; }
  
  if (taskID) {
    return taskMetas.find(meta => meta.task.id() === taskID);
  }
  
  const taskMeta = taskMetas[taskMetas.length - 1];
  if (!taskMeta || !taskMeta.task) { return undefined; }
  
  return taskMeta;
}

const I32_MAX= 2_147_483_647;

const I32_MIN = -2_147_483_648;

const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;


function contextSet(ctx, value) {
  const { componentIdx, slot } = ctx;
  if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
  if (slot === undefined) { throw new TypeError("missing slot"); }
  if (!(_typeCheckValidI32(value))) { throw new Error('invalid value for context set (not valid i32)'); }
  
  const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
  if (!currentTaskMeta) {
    throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context set`);
  }
  const taskID = currentTaskMeta.taskID;
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) { throw new Error('failed to retrieve current task'); }
  
  let task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing current task in metadata while setting context'); }
  
  _debugLog('[contextSet()] args', {
    slot,
    value,
    storage: task.storage,
    taskID: task.id(),
    componentIdx: task.componentIdx(),
  });
  
  if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
  task.storage[slot] = value;
}


function contextGet(ctx) {
  const { componentIdx, slot } = ctx;
  if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
  if (slot === undefined) { throw new TypeError("missing slot"); }
  
  const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
  if (!currentTaskMeta) {
    throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context get`);
  }
  const taskID = currentTaskMeta.taskID;
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) { throw new Error('failed to retrieve current task'); }
  
  let task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing current task in metadata while getting context'); }
  
  _debugLog('[contextGet()] args', {
    slot,
    storage: task.storage,
    taskID: task.id(),
    componentIdx: task.componentIdx(),
  });
  
  if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
  
  return task.storage[slot];
}


function taskReturn(ctx) {
  const {
    componentIdx,
    getMemoryFn,
    memoryIdx,
    callbackFnIdx,
    liftFns,
    lowerFns,
    stringEncoding,
  } = ctx;
  const params = [...arguments].slice(1);
  const memory = getMemoryFn();
  let useDirectParams = ctx.useDirectParams;
  
  const { taskID } = _getGlobalCurrentTaskMeta(componentIdx);
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) { throw new Error('failed to retrieve current task metadata'); }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing current task in metadata'); }
  
  _debugLog('[taskReturn()] args', {
    componentIdx,
    taskID: task.id(),
    subtaskID: task.getParentSubtask()?.id(),
    callbackFnIdx,
    memoryIdx,
    liftFns,
    lowerFns,
    params,
  });
  
  // If we are in a subtask, and have a fused helper function provided to use
  // via PrepareCall, we can use that function rather than performing lifting manually.
  //
  // See also documentation on `HostIntrinsic::PrepareCall`
  const subtaskCallMetadata = task.getParentSubtask()?.getCallMetadata();
  if (subtaskCallMetadata?.returnFn && !subtaskCallMetadata.returnFnCalled) {
    _debugLog('[taskReturn()] calling return fn on subtask', {
      componentIdx,
      taskID: task.id(),
      subtaskID: task.getParentSubtask()?.id(),
      returnFnParams: [...params, subtaskCallMetadata.resultPtr],
    });
    const callerTask = task.getParentSubtask().getParentTask();
    const res = _withGlobalCurrentTaskMeta({
      taskID: callerTask.id(),
      componentIdx: callerTask.componentIdx(),
      fn: () => subtaskCallMetadata.returnFn.apply(null, [...params, subtaskCallMetadata.resultPtr]),
    });
    // For sync-lowered calls the fused [return-call] helper returns
    // the lowering's flat result directly; stash it for
    // _syncStartCall to return to the blocked caller.
    subtaskCallMetadata.returnFnResult = res;
    subtaskCallMetadata.returnFnCalled = true;
    task.resolve([]);
    return;
  }
  
  const expectedMemoryIdx = task.getReturnMemoryIdx();
  if (expectedMemoryIdx !== null && memoryIdx !== null && expectedMemoryIdx !== memoryIdx) {
    _debugLog("[taskReturn()] mismatched memory indices", { expectedMemoryIdx, memoryIdx });
    throw new Error('task.return memory [' + memoryIdx + '] does not match task [' + expectedMemoryIdx + ']');
  }
  
  task.callbackFnIdx = callbackFnIdx;
  
  if (!memory && liftFns.length > 4) {
    _debugLog("[taskReturn()] memory not present for max async flat lifts");
    throw new Error('memory must be present if more than max async flat lifts are performed');
  }
  
  let liftCtx = { memory, useDirectParams, params, componentIdx, stringEncoding };
  if (!useDirectParams) {
    if (!ctx.memory) {
      _debugLog('missing memory despite indirect param usage', { useDirectParams, liftCtx, ctx });
      throw new Error('missing memory despite indirect param usage');
    }
    liftCtx.storagePtr = params[0];
    liftCtx.storageLen = params[1];
  }
  
  const liftedResults = [];
  _debugLog('[taskReturn()] lifting results out of memory', { liftCtx });
  for (const liftFn of liftFns) {
    if (liftCtx.storageLen !== undefined && liftCtx.storageLen <= 0) {
      _debugLog(`[taskReturn()] ran out of range while writing storageLen = [${liftCtx.storageLen}]`);
      throw new Error('ran out of storage while writing');
    }
    const [ val, newLiftCtx ] = liftFn(liftCtx);
    liftCtx = newLiftCtx;
    liftedResults.push(val);
  }
  
  task.resolve(liftedResults);
}

function subtaskDrop(componentIdx, subtaskWaitableRep) {
  _debugLog('[subtaskDrop()] args', { componentIdx, subtaskWaitableRep });
  
  const cstate = getOrCreateAsyncState(componentIdx);
  if (!cstate.mayLeave) { throw new Error('component is not marked as may leave, cannot be cancelled'); }
  
  const subtask = cstate.handles.remove(subtaskWaitableRep);
  if (!subtask) { throw new Error('missing/invalid subtask specified for drop in component instance'); }
  
  subtask.drop();
}


async function subtaskCancel(componentIdx, isAsync, subtaskRep) {
  _debugLog('[subtaskCancel()] args', { componentIdx, isAsync, subtaskRep });
  
  const state = getOrCreateAsyncState(componentIdx);
  if (!state.mayLeave) { throw new Error('component instance is not marked as may leave, cannot cancel subtask'); }
  
  const subtask = state.handles.get(subtaskRep);
  if (!(subtask instanceof AsyncSubtask)) {
    throw new Error('missing/invalid subtask [' + subtaskRep + '] specified for cancel in component instance');
  }
  if (subtask.resolveDelivered()) {
    throw new Error('cannot cancel subtask whose resolution has already been delivered');
  }
  if (subtask.cancellationRequested()) {
    throw new Error('cancellation has already been requested for this subtask');
  }
  if (!isAsync && subtask.waitable().isInSet()) {
    throw new Error('cannot synchronously cancel a subtask that is in a waitable set');
  }
  
  if (!subtask.isResolved()) {
    subtask.requestCancellation();
    
    if (!subtask.isResolved()) {
      // The callee did not resolve synchronously: async-lowered cancels
      // report BLOCKED (resolution will arrive via a later SUBTASK event),
      // while sync-lowered cancels block the current task until the
      // subtask resolves.
      if (isAsync) { return 0xFFFFFFFF; }
      
      const { taskID } = _getGlobalCurrentTaskMeta(componentIdx);
      const taskMeta = getCurrentTask(componentIdx, taskID);
      if (!taskMeta || !taskMeta.task) { throw new Error('invalid/missing async task'); }
      await taskMeta.task.waitUntil({
        cancellable: false,
        readyFn: () => subtask.isResolved(),
      });
    }
  }
  
  // Consume the subtask's pending resolution event (which also marks the
  // resolution as delivered), then hand the final state back to core wasm.
  // Legal states here: RETURNED, CANCELLED_BEFORE_STARTED, CANCELLED_BEFORE_RETURNED.
  if (subtask.hasPendingEvent()) { subtask.getPendingEvent(); }
  if (!subtask.resolveDelivered()) { subtask.deliverResolve(); }
  
  return subtask.getStateNumber();
}

function taskCancel(componentIdx) {
  _debugLog('[taskCancel()] args', { componentIdx });
  
  const state = getOrCreateAsyncState(componentIdx);
  if (!state.mayLeave) { throw new Error('component instance is not marked as may leave, cannot be cancelled'); }
  
  const { taskID } = _getGlobalCurrentTaskMeta(componentIdx);
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) { throw new Error('invalid/missing async task meta'); }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing async task'); }
  
  if (task.sync && !task.alwaysTaskReturn) {
    throw new Error('cannot cancel sync tasks without always task return set');
  }
  
  task.cancel();
}
const ASYNC_BLOCKED_CODE = 0xFFFF_FFFF;
function unpackCallbackResult(result) {
  if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
  const eventCode = result & 0xF;
  if (eventCode < 0 || eventCode > 3) {
    throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
  }
  if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
  // TODO: table max length check?
  const waitableSetRep = result >> 4;
  return [eventCode, waitableSetRep];
}

class WaitableSet {
  #componentIdx;
  #waitables = [];
  #pendingEvent = null;
  #waiting = 0;
  
  target;
  
  constructor(componentIdx) {
    if (componentIdx === undefined) { throw new TypeError("missing/invalid component idx"); }
    this.#componentIdx = componentIdx;
    this.target = `component [${this.#componentIdx}] waitable set`;
  }
  
  componentIdx() { return this.#componentIdx; }
  
  numWaitables() { return this.#waitables.length; }
  numWaiting() { return this.#waiting; }
  
  incrementNumWaiting(n) { this.#waiting += n ?? 1; }
  decrementNumWaiting(n) { this.#waiting -= n ?? 1; }
  
  targets() { return this.#waitables.map(w => w.target); }
  
  setTarget(tgt) { this.target = tgt; }
  
  shuffleWaitables() {
    this.#waitables = this.#waitables
    .map(value => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
  }
  
  removeWaitable(waitable) {
    const existing = this.#waitables.find(w => w === waitable);
    if (!existing) { return undefined; }
    this.#waitables = this.#waitables.filter(w => w !== waitable);
    return waitable;
  }
  
  addWaitable(waitable) {
    this.removeWaitable(waitable);
    this.#waitables.push(waitable);
  }
  
  hasPendingEvent() {
    _debugLog('[WaitableSet#hasPendingEvent()] args', {
      componentIdx: this.#componentIdx,
      waitableSet: this,
      waitableSetTargets: this.targets(),
    });
    const waitable = this.#waitables.find(w => w.hasPendingEvent());
    return waitable !== undefined;
  }
  
  getPendingEvent() {
    _debugLog('[WaitableSet#getPendingEvent()] args', {
      componentIdx: this.#componentIdx,
      waitableSet: this,
    });
    for (const waitable of this.#waitables) {
      if (!waitable.hasPendingEvent()) { continue; }
      const event = waitable.getPendingEvent();
      _debugLog('[WaitableSet#getPendingEvent()] found pending event', {
        waitable,
        event,
      });
      return event;
    }
    throw new Error('no waitables had a pending event');
  }
  
  async waitUntil(opts) {
    _debugLog('[WaitableSet#waitUntil()] args', { opts });
    // TODO(threads): this task should be the thread
    const { readyFn, task, cancellable } = opts;
    
    let event;
    
    this.incrementNumWaiting();
    
    const keepGoing = await task.suspendUntil({
      readyFn: () => {
        const hasPendingEvent = this.hasPendingEvent();
        const ready = readyFn();
        return ready && hasPendingEvent;
      },
      cancellable,
    });
    
    if (keepGoing) {
      event = this.getPendingEvent();
    } else {
      event = {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload0: 0,
        payload1: 0,
      };
    }
    
    this.decrementNumWaiting();
    
    return event;
  }
  
}

async function _driverLoop(args) {
  _debugLog('[_driverLoop()] args', args);
  const {
    componentState,
    task,
    fnName,
    isAsync,
  } = args;
  let callbackResult = args.callbackResult;
  
  const callbackFnName = task.getCallbackFnName();
  const componentIdx = task.componentIdx();
  
  if (callbackResult instanceof Promise) {
    throw new Error("callbackResult should be a value, not a promise");
  }
  
  if (callbackResult === undefined) {
    throw new Error("callback result should never be undefined");
  }
  
  let callbackCode;
  let waitableSetRep;
  let unpacked;
  try {
    if (!(_typeCheckValidI32(callbackResult))) {
      throw new Error('invalid callback result [' + callbackResult + '], not a number');
    }
    
    unpacked = unpackCallbackResult(callbackResult);
    callbackCode = unpacked[0];
    waitableSetRep = unpacked[1];
  } catch(err) {
    console.error("failed to unpack callback result", err);
    throw err;
  }
  
  if (callbackCode < 0 || callbackCode > 3) {
    throw new Error('invalid async return value, outside callback code range');
  }
  
  const cstate = getOrCreateAsyncState(componentIdx);
  
  let eventCode;
  let index;
  let result;
  let asyncRes;
  let wset;
  try {
    while (true) {
      if (callbackCode !== 0) { componentState.exclusiveRelease(task.id()); }
      
      switch (callbackCode) {
        case 0: // EXIT
        _debugLog('[_driverLoop()] async exit indicated', {
          fnName,
          componentIdx,
          callbackFnName,
          taskID: task.id()
        });
        task.exit({ skipExclusiveLockCheck: true });
        return;
        
        case 1: // YIELD
        _debugLog('[_driverLoop()] yield', {
          fnName,
          componentIdx,
          callbackFnName,
          taskID: task.id()
        });
        asyncRes = await task.yieldUntil({
          cancellable: true,
          readyFn: () => true,
        });
        _debugLog('[_driverLoop()] finished yield', {
          fnName,
          componentIdx,
          callbackFnName,
          taskID: task.id(),
          asyncRes,
        });
        break;
        
        case 2: // WAIT for a given waitable set
        _debugLog('[_driverLoop()] waiting for event', {
          fnName,
          componentIdx,
          callbackFnName,
          taskID: task.id(),
          waitableSetRep,
          waitableSetTargets: cstate.handles.get(waitableSetRep).targets(),
        });
        
        wset = cstate.handles.get(waitableSetRep);
        if (!(wset instanceof WaitableSet)) {
          throw new Error(`non-waitable set returned from component state handles @ [${waitableSetRep}]`);
        }
        
        asyncRes = await wset.waitUntil({
          readyFn: () => true,
          task,
          cancellable: true,
        });
        
        _debugLog('[_driverLoop()] finished waiting for event', {
          fnName,
          componentIdx,
          callbackFnName,
          taskID: task.id(),
          waitableSetRep,
          asyncRes,
        });
        
        break;
        
        default:
        throw new Error(`Unrecognized async function result [${ret}]`);
      }
      
      // Own the per-slice lock before delivering the event into
      // the next callback slice (FIFO-queued when another task's
      // slice is mid-flight, including across its JSPI
      // suspensions.
      await componentState.acquireExclusiveLock(task.id());
      
      // If the task failed via any means, leave early and reject.
      if (task.isRejected()) {
        _debugLog('[_driverLoop()] detected task rejection, leaving early');
        componentState.exclusiveRelease(task.id());
        return;
      }
      
      if (asyncRes.code === undefined) { throw new Error("missing event code from event"); }
      if (asyncRes.payload0 === undefined) { throw new Error("missing payload0 from event"); }
      if (asyncRes.payload1 === undefined) { throw new Error("missing payload1 from event"); }
      
      eventCode = asyncRes.code; // async event enum code
      index = asyncRes.payload0; // varies (e.g. idx of related waitable set)
      result = asyncRes.payload1; // varies (e.g. task state)
      asyncRes = null;
      
      _debugLog('[_driverLoop()] performing callback', {
        fnName,
        componentIdx,
        taskID: task.id(),
        callbackFnName,
        eventCode,
        index,
        result
      });
      
      const callbackRes = await task.runCallbackFn(
      toInt32(eventCode),
      toInt32(index),
      toInt32(result),
      );
      
      unpacked = unpackCallbackResult(callbackRes);
      callbackCode = unpacked[0];
      waitableSetRep = unpacked[1];
      
      _debugLog('[_driverLoop()] callback result unpacked', {
        fnName,
        componentIdx,
        callbackFnName,
        callbackRes,
        callbackCode,
        waitableSetRep,
      });
    }
  } catch (err) {
    _debugLog('[_driverLoop()] error during async driver loop', {
      fnName,
      callbackFnName,
      componentIdx,
      taskID: task.id(),
      subtaskID: task.getParentSubtask()?.id(),
      parentTaskID: task.getParentSubtask()?.getParentTask()?.id(),
      event: {
        eventCode,
        index,
        result,
      },
      err,
    });
    task.setErrored(err);
    task.reject(err);
  }
}

function _checkMayLeave(componentIdx) {
  if (INSTANCE_FLAGS.get(componentIdx)?.value !== 1) {
    throw new WebAssemblyRuntimeError('cannot leave component instance');
  }
}

async function _lowerImport(args) {
  const params = [...arguments].slice(1);
  _debugLog('[_lowerImport()] args', { args, params });
  const {
    functionIdx,
    componentIdx,
    isAsync,
    isManualAsync,
    paramLiftFns,
    resultLowerFns,
    hasResultPointer,
    funcTypeIsAsync,
    metadata,
    memoryIdx,
    getMemoryFn,
    getReallocFn,
    stringEncoding,
    importFn,
  } = args;
  
  _checkMayLeave(componentIdx);
  
  const { taskID } = _getGlobalCurrentTaskMeta(componentIdx);
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) { throw new Error('invalid/missing async task meta'); }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing async task'); }
  
  const cstate = getOrCreateAsyncState(componentIdx);
  
  if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
    throw new Error("non async exports cannot synchronously call async functions");
  }
  
  // If there is an existing task, this should be part of a subtask
  const memory = getMemoryFn();
  // Canonical ABI lower appends result storage as a trailing
  // param when async lower has any flat result, or sync lower
  // has more than one flat result.
  const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
  const subtask = task.createSubtask({
    componentIdx,
    parentTask: task,
    fnName: importFn.fnName,
    isAsync,
    isManualAsync,
    callMetadata: {
      memoryIdx,
      memory,
      realloc: getReallocFn?.(),
      getReallocFn,
      resultPtr,
      lowers: resultLowerFns,
      stringEncoding,
    }
  });
  task.setReturnMemoryIdx(memoryIdx);
  task.setReturnMemory(getMemoryFn());
  
  subtask.onStart();
  
  // If dealing with a sync lowered sync function, we can directly return results
  //
  // TODO(breaking): remove once we get rid of manual async import specification,
  // as func types cannot be detected in that case only (and we don't need that w/ p3)
  if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
    const res = importFn(...params);
    // TODO(breaking): remove once we get rid of manual async import specification,
    // as func types cannot be detected in that case only (and we don't need that w/ p3)
    if (!funcTypeIsAsync && !subtask.isReturned()) {
      throw new Error('post-execution subtasks must either be async or returned');
    }
    return subtask.getResult();
  }
  
  // Sync-lowered async functions requires async behavior because the callee *can* block,
  // but this call must *act* synchronously and return immediately with the result
  // (i.e. not returning until the work is done)
  //
  // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
  //
  if (!isManualAsync && !isAsync && funcTypeIsAsync) {
    const { promise, resolve, reject } = promiseWithResolvers();
    queueMicrotask(async () => {
      try {
        await importFn(...params);
        if (!subtask.isResolved()) {
          await task.suspendUntil({ readyFn: () => subtask.isResolved() });
        }
        resolve(subtask.getResult());
      } catch (err) {
        reject(err);
      }
    });
    return promise;
  }
  
  // NOTE: at this point we know that we are working with an async lowered import
  
  subtask.setOnProgressFn(() => {
    subtask.setPendingEvent(() => {
      if (subtask.isResolved()) { subtask.deliverResolve(); }
      const event = {
        code: ASYNC_EVENT_CODE.SUBTASK,
        payload0: subtask.waitableRep(),
        payload1: subtask.getStateNumber(),
      }
      return event;
    });
  });
  
  // This is a hack to maintain backwards compatibility with
  // manually-specified async imports, used in wasm exports that are
  // not actually async (but are specified as so).
  //
  // This is not normal p3 sync behavior but instead anticipating that
  // the caller that is doing manual async will be waiting for a promise that
  // resolves to the *actual* result.
  //
  // TODO(breaking): remove once manually specified async is removed
  //
  // There are a few cases:
  // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
  // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
  // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
  // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
  //
  // This hack *only* applies to 4 -- the case where an async JS host function
  // is supplied to a Wasm export which does *not* need to do any async abi
  // lifting/lowering (async ABI did not exist when JSPI integratiton was
  // initially merged to enable asynchronously returning values from the host)
  //
  const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
  let manualAsyncResult;
  if (requiresManualAsyncResult) {
    manualAsyncResult = promiseWithResolvers();
  }
  
  // Build a response that *may* resolve quickly
  
  queueMicrotask(async () => {
    try {
      _debugLog('[_lowerImport()] calling lowered import', { importFn, params });
      await importFn(...params);
      if (requiresManualAsyncResult) {
        manualAsyncResult.resolve(subtask.getResult());
      }
    } catch (err) {
      _debugLog("[_lowerImport()] import fn error:", err);
      if (requiresManualAsyncResult) {
        manualAsyncResult.reject(err);
        return;
      }
      task.setErrored(err);
      task.reject(err);
    }
  });
  
  if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
  
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      // NOTE: whether the import settled before this timer fires is a race
      // between the import's settlement (microtask + any host timers), this
      // setTimeout(0), and JSPI resume scheduling -- engines order these
      // differently (e.g. V8 13.6 vs 14.x). Either outcome is CABI-legal,
      // but the invariants of each branch must hold independently, and this
      // promise must *always* settle (an unhandled throw here would leave a
      // JSPI-suspended guest suspended forever).
      try {
        const subtaskState = subtask.getStateNumber();
        if (subtaskState < 0 || subtaskState >= 2**4) {
          reject(new Error('invalid subtask state, out of valid range'));
          return;
        }
        let res;
        // An async-lowered import whose callee resolved synchronously returns
        // [Subtask.State.RETURNED] only and no subtask handle is exposed.
        if (subtask.isReturned()) {
          // The on-progress handler parked a pending SUBTASK event on the
          // waitable when the import settled. The guest never learns this
          // waitable's rep (we return a bare RETURNED state), so consume the
          // event now -- otherwise a stale event is left parked forever (and
          // the waitable can never be dropped).
          if (subtask.hasPendingEvent()) {
            subtask.getPendingEvent();
          }
          if (!subtask.resolveDelivered()) {
            subtask.deliverResolve();
          }
          const removed = cstate.handles.remove(subtask.waitableRep());
          if (removed !== subtask) {
            reject(new Error('subtask handle cleanup removed unexpected entry'));
            return;
          }
          subtask.drop();
          res = subtaskState;
        } else {
          res = Number(subtask.waitableRep()) << 4 | subtaskState;
        }
        _debugLog('[_lowerImport()] async-lowered import return', {
          fnName: importFn.fnName,
          componentIdx,
          subtaskID: subtask.id(),
          waitableRep: subtask.waitableRep(),
          subtaskState,
          eagerReturn: subtask.isReturned(),
          packedResult: res,
        });
        resolve(res);
      } catch (err) {
        reject(err);
      }
    }, 0);
  });
}

function _setGlobalCurrentTaskMeta(args) {
  if (!args) { throw new TypeError('args missing'); }
  if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
  if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
  const { taskID, componentIdx } = args;
  return CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
}


async function _clearCurrentTask(args) {
  _debugLog('[_clearCurrentTask()] args', args);
  if (!args) { throw new TypeError('args missing'); }
  if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
  if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
  const { taskID, componentIdx } = args;
  
  const meta = CURRENT_TASK_META[componentIdx];
  if (!meta) { throw new Error(`missing current task meta for component idx [${componentIdx}]`); }
  
  if (meta.taskID !== taskID) {
    throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
  }
  if (meta.componentIdx !== componentIdx) {
    throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
  }
  
  CURRENT_TASK_META[componentIdx] = null;
}

function _lowerImportBackwardsCompat(args) {
  const params = [...arguments].slice(1);
  _debugLog('[_lowerImportBackwardsCompat()] args', { args, params });
  const {
    functionIdx,
    componentIdx,
    isAsync,
    isManualAsync,
    paramLiftFns,
    resultLowerFns,
    hasResultPointer,
    funcTypeIsAsync,
    metadata,
    memoryIdx,
    getMemoryFn,
    getReallocFn,
    importFn,
    stringEncoding,
  } = args;
  
  _checkMayLeave(componentIdx);
  
  let meta = _getGlobalCurrentTaskMeta(componentIdx);
  let createdTask;
  
  // Some components depend on initialization logic (i.e. `_initialize` or some such
  // core wasm export) that is embedded in the component, but is not executed or wizer'd
  // away before the transpiled component is attempted to be used.
  //
  // These components execut their initialization logic *when they are imported* in the
  // transpiled context -- so we may get a call to an export that is lowered without going
  // through `CallWasm` or `CallInterface`.
  //
  if (!meta) {
    if (funcTypeIsAsync || (isAsync && !isManualAsync)) {
      throw new Error('p3 async wasm exports cannot use backwards compat auto-task init');
    }
    
    const [newTask, newTaskID] = createNewCurrentTask({
      componentIdx,
      isAsync,
      isManualAsync,
      callingWasmExport: false,
    });
    createdTask = newTask;
    
    // Since we're managing the task creation ourselves we must clear ourselves
    createdTask.registerOnResolveHandler(() => {
      _clearCurrentTask({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
      });
    });
    
    _setGlobalCurrentTaskMeta({
      componentIdx,
      taskID: newTaskID,
    });
    
    meta = _getGlobalCurrentTaskMeta(componentIdx);
  }
  
  const { taskID } = meta;
  
  const taskMeta = getCurrentTask(componentIdx, taskID);
  if (!taskMeta) {
    throw new Error('invalid/missing async task meta');
  }
  
  const task = taskMeta.task;
  if (!task) { throw new Error('invalid/missing async task'); }
  
  const cstate = getOrCreateAsyncState(componentIdx);
  
  if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
    throw new Error("non async exports cannot synchronously call async functions");
  }
  
  // If there is an existing task, this should be part of a subtask
  const memory = getMemoryFn();
  // Canonical ABI lower appends result storage as a trailing
  // param when async lower has any flat result, or sync lower
  // has more than one flat result.
  const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
  const subtask = task.createSubtask({
    componentIdx,
    parentTask: task,
    fnName: importFn.fnName,
    isAsync,
    isManualAsync,
    callMetadata: {
      memoryIdx,
      memory,
      realloc: getReallocFn?.(),
      getReallocFn,
      resultPtr,
      lowers: resultLowerFns,
      stringEncoding,
    }
  });
  task.setReturnMemoryIdx(memoryIdx);
  task.setReturnMemory(getMemoryFn());
  
  subtask.onStart();
  
  // If dealing with a sync lowered sync function, we can directly return results
  //
  // TODO(breaking): remove once we get rid of manual async import specification,
  // as func types cannot be detected in that case only (and we don't need that w/ p3)
  if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
    if (createdTask) { createdTask.enterSync(); }
    
    const res = importFn(...params);
    
    // TODO(breaking): remove once we get rid of manual async import specification,
    // as func types cannot be detected in that case only (and we don't need that w/ p3)
    if (!funcTypeIsAsync && !subtask.isReturned()) {
      throw new Error('post-execution subtasks must either be async or returned');
    }
    
    const syncRes = subtask.getResult();
    if (createdTask) { createdTask.resolve([syncRes]); }
    
    return syncRes;
  }
  
  // Sync-lowered async functions requires async behavior because the callee *can* block,
  // but this call must *act* synchronously and return immediately with the result
  // (i.e. not returning until the work is done)
  //
  // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
  //
  if (!isManualAsync && !isAsync && funcTypeIsAsync) {
    const { promise, resolve, reject } = promiseWithResolvers();
    queueMicrotask(async () => {
      try {
        await importFn(...params);
        if (!subtask.isResolved()) {
          await task.suspendUntil({ readyFn: () => subtask.isResolved() });
        }
        resolve(subtask.getResult());
      } catch (err) {
        reject(err);
      }
    });
    return promise;
  }
  
  // NOTE: at this point we know that we are working with an async lowered import
  
  const subtaskState = subtask.getStateNumber();
  if (subtaskState < 0 || subtaskState >= 2**4) {
    throw new Error('invalid subtask state, out of valid range');
  }
  
  subtask.setOnProgressFn(() => {
    subtask.setPendingEvent(() => {
      if (subtask.isResolved()) { subtask.deliverResolve(); }
      const event = {
        code: ASYNC_EVENT_CODE.SUBTASK,
        payload0: subtask.waitableRep(),
        payload1: subtask.getStateNumber(),
      }
      return event;
    });
  });
  
  // This is a hack to maintain backwards compatibility with
  // manually-specified async imports, used in wasm exports that are
  // not actually async (but are specified as so).
  //
  // This is not normal p3 sync behavior but instead anticipating that
  // the caller that is doing manual async will be waiting for a promise that
  // resolves to the *actual* result.
  //
  // TODO(breaking): remove once manually specified async is removed
  //
  // There are a few cases:
  // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
  // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
  // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
  // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
  //
  // This hack *only* applies to 4 -- the case where an async JS host function
  // is supplied to a Wasm export which does *not* need to do any async abi
  // lifting/lowering (async ABI did not exist when JSPI integratiton was
  // initially merged to enable asynchronously returning values from the host)
  //
  const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
  let manualAsyncResult;
  if (requiresManualAsyncResult) {
    manualAsyncResult = promiseWithResolvers();
  }
  
  queueMicrotask(async () => {
    try {
      _debugLog('[_lowerImportBackwardsCompat()] calling lowered import', { importFn, params });
      if (createdTask) { await createdTask.enter(); }
      
      const asyncRes = await importFn(...params);
      if (requiresManualAsyncResult) {
        manualAsyncResult.resolve(subtask.getResult());
      }
      
      if (createdTask) { createdTask.resolve([asyncRes]); }
      
      
    } catch (err) {
      _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
      if (requiresManualAsyncResult) {
        manualAsyncResult.reject(err);
        return;
      }
      task.setErrored(err);
      task.reject(err);
    }
  });
  
  if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
  
  _debugLog('[_lowerImportBackwardsCompat()] async-lowered import return', {
    fnName: importFn.fnName,
    componentIdx,
    subtaskID: subtask.id(),
    waitableRep: subtask.waitableRep(),
    subtaskState,
    packedResult: Number(subtask.waitableRep()) << 4 | subtaskState,
  });
  
  return Number(subtask.waitableRep()) << 4 | subtaskState;
}

const CURRENT_TASK_MAY_BLOCK= globalThis.WebAssembly ? new globalThis.WebAssembly.Global({ value: 'i32', mutable: true }, 0) : false;


function waitableSetNew(componentIdx) {
  _debugLog('[waitableSetNew()] args', { componentIdx });
  
  const state = getOrCreateAsyncState(componentIdx);
  if (!state) {throw new Error(`missing async state for component idx [${componentIdx}]`); }
  
  const wset = new WaitableSet(componentIdx);
  const rep = state.handles.insert(wset);
  if (typeof rep !== 'number') { throw new Error(`invalid/missing waitable set rep [${rep}]`); }
  
  _debugLog('[waitableSetNew()] created waitable set', { componentIdx, rep });
  return rep;
}

function _storeEventInComponentMemory(args) {
  _debugLog('[_storeEventInComponentMemory()] args', args);
  const { memory, ptr, event } = args;
  
  if (!memory) { throw new Error('unexpectedly missing memory'); }
  if (ptr === undefined || ptr === null) { throw new Error('unexpectedly missing pointer'); }
  if (!event) { throw new Error('event object missing'); }
  if (event.code === undefined) { throw new Error('invalid event object, missing code'); }
  if (event.payload0 === undefined) { throw new Error('invalid event object, missing payload0'); }
  if (event.payload1 === undefined) { throw new Error('invalid event object, missing payload1'); }
  
  const dv = new DataView(memory.buffer);
  dv.setUint32(ptr, event.payload0, true);
  dv.setUint32(ptr + 4, event.payload1, true);
  
  return event.code;
}

function waitableSetPoll(ctx, waitableSetRep, resultPtr) {
  const { componentIdx, memoryIdx, getMemoryFn, isAsync, isCancellable } = ctx;
  _debugLog('[waitableSetPoll()] args', {
    componentIdx,
    memoryIdx,
    waitableSetRep,
    resultPtr,
  });
  
  const taskMeta = getCurrentTask(componentIdx);
  if (!taskMeta) { throw Error('invalid/missing current task meta'); }
  if (taskMeta.componentIdx !== componentIdx) {
    throw Error('task component idx [' + task.componentIdx + '] != component instance ID [' + componentIdx + ']');
  }
  
  const task = taskMeta.task;
  if (!task) { throw Error('invalid/missing async task in task meta'); }
  
  if (task.componentIdx() !== componentIdx) {
    throw Error(`task component idx [${task.componentIdx()}] does not match generated [${componentIdx}]`);
  }
  
  const cstate = getOrCreateAsyncState(task.componentIdx());
  const wset = cstate.handles.get(waitableSetRep);
  if (!wset) {
    throw new Error(`missing waitable set [${waitableSetRep}] in component [${componentIdx}]`);
  }
  
  let event;
  const cancelDelivered = task.deliverPendingCancel({ cancellable: isCancellable });
  if (cancelDelivered) {
    _debugLog('[waitableSetPoll()] detected cancel delivered', {
      componentIdx,
      waitableSetRep,
    });
    event = { code: ASYNC_EVENT_CODE.TASK_CANCELLED, payload0: 0, payload1: 0 };
  } else if (!wset.hasPendingEvent()) {
    _debugLog('[waitableSetPoll()] no pending event', {
      componentIdx,
      waitableSetRep,
    });
    event = { code: ASYNC_EVENT_CODE.NONE, payload0: 0, payload1: 0 };
  } else {
    _debugLog('[waitableSetPoll()] retrieving waiting pending event', {
      componentIdx,
      waitableSetRep,
    });
    event = wset.getPendingEvent();
  }
  
  const eventCode = _storeEventInComponentMemory({
    event,
    ptr: resultPtr,
    memory: getMemoryFn(),
    componentIdx,
    task,
    memoryIdx,
  });
  
  return eventCode;
}

function _removeWaitableSet(args) {
  _debugLog('[_removeWaitableSet()] args', args);
  const { state, waitableSetRep } = args;
  if (!state) { throw new TypeError("missing component state"); }
  if (!waitableSetRep) { throw new TypeError("missing component waitableSetRep"); }
  
  const ws = state.handles.get(waitableSetRep);
  if (!ws) {
    throw new Error('cannot remove waitable set: no set present with rep [' + waitableSetRep + ']');
  }
  if (ws.hasPendingEvent()) {
    throw new Error('waitable set cannot be removed with pending items remaining');
  }
  
  const waitableSet = state.handles.get(waitableSetRep);
  if (ws.numWaitables() > 0) {
    throw new Error('waitable set still contains waitables');
  }
  if (ws.numWaiting() > 0) {
    throw new Error('waitable set still has other tasks waiting on it');
  }
  
  state.handles.remove(waitableSetRep);
}

function waitableSetDrop(componentIdx, waitableSetRep) {
  _debugLog('[waitableSetDrop()] args', { componentIdx, waitableSetRep });
  const task = getCurrentTask(componentIdx);
  
  if (!task) { throw new Error('invalid/missing async task'); }
  if (task.componentIdx !== componentIdx) {
    throw Error('task component idx [' + task.componentIdx + '] != component instance ID [' + componentIdx + ']');
  }
  
  const state = getOrCreateAsyncState(componentIdx);
  if (!state.mayLeave) { throw new Error('component instance is not marked as may leave, cannot be cancelled'); }
  
  _removeWaitableSet({ state, waitableSetRep });
}

function waitableJoin(componentIdx, waitableRep, waitableSetRep) {
  _debugLog('[waitableJoin()] args', {
    componentIdx,
    waitableSetRep,
    isRemoval: waitableSetRep === 0,
    waitableRep,
  });
  
  const state = getOrCreateAsyncState(componentIdx);
  if (!state) {
    throw new Error(`invalid/missing async state for component instance [${componentIdx}]`);
  }
  
  if (!state.mayLeave) {
    throw new Error('component instance is not marked as may leave, cannot join waitable');
  }
  
  const waitableObj = state.handles.get(waitableRep);
  if (!waitableObj) {
    throw new Error(`missing waitable obj (rep [${waitableRep}]), component idx [${componentIdx}])`);
  }
  const waitable = waitableObj.getWaitable ? waitableObj.getWaitable() : waitableObj;
  if (!waitable.join) {
    throw new Error("invalid waitable object, does not have join()");
  }
  
  const waitableSet = waitableSetRep === 0 ? null : state.handles.get(waitableSetRep);
  if (waitableSetRep !== 0 && !waitableSet) {
    throw new Error(`missing waitable set [${waitableSetRep}] in component idx [${componentIdx}]`);
  }
  
  waitable.join(waitableSet);
}

function _liftFlatBool(ctx) {
  _debugLog('[_liftFlatBool()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
    val = ctx.params[0] === 1;
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 1) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (bool requires 1 byte)`);
  }
  
  val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true) === 1;
  
  ctx.storagePtr += 1;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 1; }
  
  return [val, ctx];
}


function _liftFlatU8(ctx) {
  _debugLog('[_liftFlatU8()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
    val = ctx.params[0];
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 1) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u8 requires 1 byte)`);
  }
  
  val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true);
  
  ctx.storagePtr += 1;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 1; }
  
  return [val, ctx];
}


function _liftFlatU16(ctx) {
  _debugLog('[_liftFlatU16()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
    val = ctx.params[0];
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 2) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u16 requires 2 bytes)`);
  }
  
  val = new DataView(ctx.memory.buffer).getUint16(ctx.storagePtr, true);
  
  ctx.storagePtr += 2;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 2; }
  
  const rem = ctx.storagePtr % 2;
  if (rem !== 0) { ctx.storagePtr += (2 - rem); }
  
  return [val, ctx];
}


function _liftFlatS32(ctx) {
  _debugLog('[_liftFlatS32()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
    val = ctx.params[0];
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (s32 requires 4 bytes)`);
  }
  
  val = new DataView(ctx.memory.buffer).getInt32(ctx.storagePtr, true);
  ctx.storagePtr += 4;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
  
  return [val, ctx];
}


function _liftFlatU32(ctx) {
  _debugLog('[_liftFlatU32()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least a single i34 argument'); }
    // core i32 values arrive as signed numbers
    val = ctx.params[0] >>> 0;
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
  }
  val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
  ctx.storagePtr += 4;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
  
  return [val, ctx];
}


function _liftFlatU64(ctx) {
  _debugLog('[_liftFlatU64()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least one single i64 argument'); }
    if (typeof ctx.params[0] !== 'bigint') { throw new Error('expected bigint'); }
    // core i64 values arrive as signed BigInts
    val = BigInt.asUintN(64, ctx.params[0]);
    ctx.params = ctx.params.slice(1);
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u64 requires 8 bytes)`);
  }
  
  val = new DataView(ctx.memory.buffer).getBigUint64(ctx.storagePtr, true);
  ctx.storagePtr += 8;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
  
  return [val, ctx];
}


function _liftFlatFloat32(ctx) {
  _debugLog('[_liftFlatFloat32()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) { throw new Error('expected at least one single f32 argument'); }
    val = ctx.params[0];
    ctx.params = ctx.params.slice(1);
    
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (f32 requires 4 bytes)`);
  }
  
  val = new DataView(ctx.memory.buffer).getFloat32(ctx.storagePtr, true);
  
  ctx.storagePtr += 4;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
  
  return [val, ctx];
}


function _liftFlatFloat64(ctx) {
  _debugLog('[_liftFlatFloat64()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length === 0) {
      throw new Error('expected at least one single f64 argument');
    }
    val = ctx.params[0];
    ctx.params = ctx.params.slice(1);
    
    return [val, ctx];
  }
  
  if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
    throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (f64 requires 8 bytes)`);
  }
  
  val = new DataView(ctx.memory.buffer).getFloat64(ctx.storagePtr, true);
  ctx.storagePtr += 8;
  if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
  
  return [val, ctx];
}


function _liftFlatStringUTF8(ctx) {
  _debugLog('[_liftFlatStringUTF8()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
    let offset = ctx.params[0];
    if (typeof offset === 'bigint') { offset = Number(offset); }
    if (!Number.isSafeInteger(offset)) { throw new Error('invalid offset'); }
    const len = ctx.params[1];
    if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
    val = TEXT_DECODER_UTF8.decode(new DataView(ctx.memory.buffer, offset, len));
    ctx.params = ctx.params.slice(2);
    return [val, ctx];
  }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  const dv = new DataView(ctx.memory.buffer);
  const start = dv.getUint32(ctx.storagePtr, true);
  const codeUnits = dv.getUint32(ctx.storagePtr + 4, true);
  
  val = TEXT_DECODER_UTF8.decode(new Uint8Array(ctx.memory.buffer, start, codeUnits));
  
  ctx.storagePtr += 8;
  if (ctx.storageLen !== undefined) { ctx.storagelen -= 8; }
  
  return [val, ctx];
}

function _liftFlatStringUTF16(ctx) {
  _debugLog('[_liftFlatStringUTF16()] args', { ctx });
  let val;
  
  if (ctx.useDirectParams) {
    if (ctx.params.length < 2) { throw new Error('expected at least two u32 arguments'); }
    let offset = ctx.params[0];
    if (typeof offset === 'bigint') { offset = Number(offset); }
    if (!Number.isSafeInteger(offset)) {  throw new Error('invalid offset'); }
    const len = ctx.params[1];
    if (!Number.isSafeInteger(len)) {  throw new Error('invalid len'); }
    val = utf16Decoder.decode(new DataView(ctx.memory.buffer, offset, len));
    ctx.params = ctx.params.slice(2);
    return [val, ctx];
  }
  
  const data = new DataView(ctx.memory.buffer)
  const start = data.getUint32(ctx.storagePtr, vals[0], true);
  const codeUnits = data.getUint32(ctx.storagePtr, vals[0] + 4, true);
  val = utf16Decoder.decode(new Uint16Array(ctx.memory.buffer, start, codeUnits));
  ctx.storagePtr = ctx.storagePtr + 2 * codeUnits;
  if (ctx.storageLen !== undefined) { ctx.storageLen = ctx.storageLen - 2 * codeUnits }
  
  return [val, ctx];
}

function _liftFlatStringAny(ctx) {
  switch (ctx.stringEncoding) {
    case 'utf8':
    return _liftFlatStringUTF8(ctx);
    case 'utf16':
    return _liftFlatStringUTF16(ctx);
    default:
    throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
  }
}

function _liftFlatRecord(meta) {
  const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
  return function _liftFlatRecordInner(ctx) {
    _debugLog('[_liftFlatRecord()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const res = {};
    for (const [key, liftFn, size32, align32] of fieldMetas) {
      let fieldPtr;
      if (ctx.storagePtr !== undefined) {
        const rem = ctx.storagePtr % align32;
        if (rem !== 0) { ctx.storagePtr += align32 - rem; }
        fieldPtr = ctx.storagePtr;
      }
      
      // A field occupies exactly size32 bytes of the record's
      // flat storage. Capture the remaining storage budget before
      // lifting the field and restore it afterwards: a field's own
      // lift fn may repurpose storageLen internally (e.g. a list
      // sets it to the element-buffer length while reading
      // out-of-line data and never restores it), which would
      // otherwise corrupt the budget the next field sees.
      // See https://github.com/bytecodealliance/jco/issues/1585.
      let fieldLen;
      if (ctx.storageLen !== undefined) { fieldLen = ctx.storageLen; }
      
      let [val, newCtx] = liftFn(ctx);
      res[key] = val;
      ctx = newCtx;
      
      if (fieldPtr !== undefined) {
        ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
      }
      if (fieldLen !== undefined) {
        ctx.storageLen = fieldLen - size32;
      }
    }
    
    if (originalPtr !== undefined) {
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
    }
    
    if (ctx.storagePtr !== undefined) {
      const rem = ctx.storagePtr % recordAlign32;
      if (rem !== 0) { ctx.storagePtr += recordAlign32 - rem; }
    }
    
    return [res, ctx];
  }
}

const _liftFlatVariantScratch = new DataView(new ArrayBuffer(8));

function _liftFlatVariant(meta) {
  const {
    caseMetas,
    variantSize32,
    variantAlign32,
    variantPayloadOffset32,
    variantFlatCount,
    variantPayloadFlatTypes,
    isEnum,
  } = meta;
  
  return function _liftFlatVariantInner(ctx) {
    _debugLog('[_liftFlatVariant()] args', { ctx });
    const origUseParams = ctx.useDirectParams;
    
    let caseIdx;
    let liftRes;
    const originalPtr = ctx.storagePtr;
    const numCases =  caseMetas.length;
    if (caseMetas.length < 256) {
      liftRes = _liftFlatU8(ctx);
    } else if (numCases >= 256 && numCases < 65536) {
      liftRes = _liftFlatU16(ctx);
    } else if (numCases >= 65536 && numCases < 4_294_967_296) {
      liftRes = _liftFlatU32(ctx);
    } else {
      throw new Error(`unsupported number of variant cases [${numCases}]`);
    }
    caseIdx = liftRes[0];
    ctx = liftRes[1];
    
    const [
    tag,
    liftFn,
    caseSize32,
    caseAlign32,
    caseFlatCount,
    caseFlatTypes,
    ] = caseMetas[caseIdx];
    
    if (variantPayloadOffset32 === undefined) {
      throw new Error('unexpectedly missing payload offset');
    }
    
    if (originalPtr !== undefined) {
      ctx.storagePtr = originalPtr + variantPayloadOffset32;
    }
    
    let val;
    if (liftFn === null) {
      val = { tag };
      // NOTE: here we need to move past the entire object in memory
      // despite moving to the payload which we now know is missing/unnecessary
      if (originalPtr !== undefined) {
        ctx.storagePtr = originalPtr + variantSize32;
      }
    } else {
      // When lifting from direct params, the payload arrives as the
      // *join* of all case flat representations: each slot whose
      // joined core type differs from the selected case's core type
      // must be reinterpreted before the payload lift
      // (see CanonicalABI `lift_flat_variant`)
      if (ctx.useDirectParams) {
        if (!variantPayloadFlatTypes || !caseFlatTypes) {
          throw new Error('missing variant flat type metadata during direct-param lift');
        }
        const scratch = _liftFlatVariantScratch;
        for (let i = 0; i < caseFlatTypes.length; i++) {
          const have = variantPayloadFlatTypes[i];
          const want = caseFlatTypes[i];
          if (have === want) { continue; }
          const val = ctx.params[i];
          if (have === 'i64' && want === 'i32') {
            ctx.params[i] = Number(BigInt.asIntN(32, val));
          } else if (have === 'i64' && want === 'f32') {
            scratch.setInt32(0, Number(BigInt.asIntN(32, val)), true);
            ctx.params[i] = scratch.getFloat32(0, true);
          } else if (have === 'i64' && want === 'f64') {
            scratch.setBigInt64(0, val, true);
            ctx.params[i] = scratch.getFloat64(0, true);
          } else if (have === 'i32' && want === 'f32') {
            scratch.setInt32(0, val, true);
            ctx.params[i] = scratch.getFloat32(0, true);
          } else {
            throw new Error(`invalid variant payload coercion [${have}] -> [${want}]`);
          }
        }
      }
      
      const [newVal, newCtx] = liftFn(ctx);
      val = { tag, val: newVal };
      ctx = newCtx;
    }
    
    if (origUseParams) {
      if (variantFlatCount === undefined || variantFlatCount === null) {
        _debugLog('[_liftFlatVariant()] variant with unknown flat count', { ctx, meta });
        throw new Error('cannot lift variant with unknown flat count');
      }
      if (caseFlatCount === undefined || caseFlatCount === null) {
        _debugLog('[_liftFlatVariant()] case with unknown flat count', { ctx, meta, case: meta.caseMetas[caseIdx] });
        throw new Error('cannot lift case with unknown flat count');
      }
      // NOTE: enums can be tightly packed and do not have a descriminant
      const remainingPayloadParams = variantFlatCount - caseFlatCount - (isEnum ? 0 : 1);
      if (remainingPayloadParams < 0) {
        throw new Error(`invalid variant flat count metadata`);
      }
      if (ctx.params.length < remainingPayloadParams) {
        throw new Error(`expected at least [${remainingPayloadParams}] remaining variant payload params, but got [${ctx.params.length}]`);
      }
      ctx.params = ctx.params.slice(remainingPayloadParams);
    }
    
    if (ctx.storagePtr !== undefined) {
      const rem = ctx.storagePtr % variantAlign32;
      if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
    }
    
    return [val, ctx];
  }
}

function _liftFlatList(meta) {
  const { elemLiftFn, elemSize32, elemAlign32, knownLen, typedArray } = meta;
  
  const listValue =
  typedArray === undefined
  ? values => values
  : values => new typedArray(values);
  
  const readValuesAndReset = (ctx, originalPtr, originalLen, dataPtr, len) => {
    if (dataPtr % elemAlign32 !== 0) {
      throw new TypeError(`list pointer [${dataPtr}] is not aligned to ${elemAlign32}`);
    }
    ctx.storagePtr = dataPtr;
    const val = [];
    for (var i = 0; i < len; i++) {
      const elemPtr = dataPtr + i * elemSize32;
      ctx.storagePtr = elemPtr;
      const [res, nextCtx] = elemLiftFn(ctx);
      val.push(res);
      ctx = nextCtx;
      
      ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
    }
    if (originalPtr !== null) { ctx.storagePtr = originalPtr; }
    if (originalLen !== null) { ctx.storageLen = originalLen; }
    return [listValue(val), ctx];
  };
  
  return function _liftFlatListInner(ctx) {
    _debugLog('[_liftFlatList()] args', { ctx });
    
    let liftResults;
    if (knownLen !== undefined) { // list with known length
    if (ctx.useDirectParams) {
      _debugLog('memory unexpectedly missing while lifting unknown length list', { ctx });
      liftResults = [listValue(ctx.params.slice(0, knownLen)), ctx];
      ctx.params = ctx.params.slice(knownLen);
    } else { // indirect params
    if (ctx.memory === null) {
      _debugLog('memory unexpectedly missing while lifting known length list', { knownLen, ctx });
      throw new Error(`memory missing while lifting known length (${knownLen}) list`);
    }
    
    const originalLen = ctx.storageLen;
    const originalPtr = ctx.storagePtr;
    
    ctx.storageLen = knownLen * elemSize32;
    liftResults = readValuesAndReset(ctx, null, originalLen, ctx.storagePtr, knownLen);
  }
  
} else { // unknown length list

if (ctx.useDirectParams) {
  // unknown length list ptr w/ direct params
  const dataPtr = ctx.params[0];
  const len = ctx.params[1];
  ctx.params = ctx.params.slice(2);
  
  ctx.useDirectParams = false;
  const originalPtr = ctx.storagePtr;
  const originalLen = ctx.storageLen;
  ctx.storageLen = len * elemSize32;
  
  liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
  
  ctx.useDirectParams = true;
} else {
  // unknown length list ptr w/ in-memory params
  const originalLen = ctx.storageLen;
  ctx.storageLen = 8;
  
  const dataPtrLiftRes = _liftFlatU32(ctx);
  const dataPtr = dataPtrLiftRes[0];
  ctx = dataPtrLiftRes[1];
  
  const lenLiftRes = _liftFlatU32(ctx);
  const len = lenLiftRes[0];
  ctx = lenLiftRes[1];
  
  const originalPtr = ctx.storagePtr;
  ctx.storagePtr = dataPtr;
  
  ctx.storageLen = len * elemSize32;
  liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
}
}

return liftResults;
}
}

function _liftFlatFlags(meta) {
  const { names, size32, align32, intSizeBytes } = meta;
  
  return function _liftFlatFlagsInner(ctx) {
    _debugLog('[_liftFlatFlags()] args', { ctx });
    
    let val = {};
    
    let liftRes;
    let align;
    switch (intSizeBytes) {
      case 1:
      liftRes = _liftFlatU8(ctx);
      break;
      case 2:
      liftRes = _liftFlatU16(ctx);
      break;
      case 4:
      liftRes = _liftFlatU32(ctx);
      break;
      default:
      throw new Error('invalid flags size');
    }
    let bits = liftRes[0];
    ctx = liftRes[1];
    
    
    for (const name of names) {
      val[name] = (bits & 1) === 1;
      bits >>>= 1;
    }
    
    
    const rem = ctx.storagePtr % align32;
    if (rem !== 0) { ctx.storagePtr += align32 - rem; }
    
    return [val, ctx];
  }
}

function _liftFlatEnum(meta) {
  meta.isEnum = true;
  const f = _liftFlatVariant(meta);
  return function _liftFlatEnumInner(ctx) {
    _debugLog('[_liftFlatEnum()] args', { ctx });
    const res = f(ctx);
    res[0] = res[0].tag;
    return res;
  }
}

function _liftFlatOption(meta) {
  const f = _liftFlatVariant(meta);
  return function _liftFlatOptionInner(ctx) {
    _debugLog('[_liftFlatOption()] args', { ctx });
    return f(ctx);
  }
}

function _liftFlatOwn(meta) {
  const { classNameFn, createResourceFn, componentIdx } = meta;
  
  return function _liftFlatOwnInner(ctx) {
    _debugLog('[_liftFlatOwn()] args', { ctx, className: classNameFn() });
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error('invalid component for resource lift');
    }
    
    const [handle, newCtx] = _liftFlatU32(ctx);
    const resource = createResourceFn(handle);
    
    return [resource, newCtx];
  }
}

function _liftFlatBorrow(componentTableIdx, size, memory, vals, storagePtr, storageLen) {
  _debugLog('[_liftFlatBorrow()] args', { size, memory, vals, storagePtr, storageLen });
  throw new Error('flat lift for borrowed resources is not supported!');
}


function _lowerFlatBool(ctx) {
  _debugLog('[_lowerFlatBool()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('bool', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint8(ctx.storagePtr, ctx.vals[0] ? 1 : 0);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU8(ctx) {
  _debugLog('[_lowerFlatU8()] args', ctx);
  
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('u8', ctx.vals[0]);
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  new DataView(ctx.memory.buffer).setUint8(ctx.storagePtr, ctx.vals[0]);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU16(ctx) {
  _debugLog('[_lowerFlatU16()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  const rem = ctx.storagePtr % 2;
  if (rem !== 0) { ctx.storagePtr += (2 - rem); }
  
  _requireValidNumericPrimitive.bind('u16', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint16(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 2;
}

function _lowerFlatU32(ctx) {
  _debugLog('[_lowerFlatU32()] args', { ctx });
  
  if (ctx.vals.length !== 1) {
    throw new Error(`expected single value to lower, got [${ctx.vals.length}]`);
  }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  _requireValidNumericPrimitive.bind('u32', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 4;
}

function _lowerFlatFloat64(ctx) {
  _debugLog('[_lowerFlatFloat64()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 8;
  if (rem !== 0) { ctx.storagePtr += (8 - rem); }
  
  _requireValidNumericPrimitive.bind('f64', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setFloat64(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF8(ctx) {
  _debugLog('[_lowerFlatStringUTF8()] args', ctx);
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const { ptr, len } = _utf8AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, len, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF16(ctx) {
  _debugLog('[_lowerFlatStringUTF16()] args', { ctx });
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const { ptr, len } = _utf16AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, len, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringAny(ctx) {
  switch (ctx.stringEncoding) {
    case 'utf8':
    return _lowerFlatStringUTF8(ctx);
    case 'utf16':
    return _lowerFlatStringUTF16(ctx);
    default:
    throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
  }
}

function _lowerFlatRecord(meta) {
  const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
  return function _lowerFlatRecordInner(ctx) {
    _debugLog('[_lowerFlatRecord()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const r = ctx.vals[0];
    for (const [tag, lowerFn, size32, align32 ] of fieldMetas) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const fieldPtr = ctx.storagePtr;
      ctx.vals = [r[tag]];
      lowerFn(ctx);
      
      ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
    
    const rem = ctx.storagePtr % recordAlign32;
    if (rem !== 0) {
      ctx.storagePtr += recordAlign32 - rem;
    }
  }
}

function _lowerFlatVariant(meta) {
  const { variantSize32, variantAlign32, variantPayloadOffset32, caseMetas } = meta;
  
  let caseLookup = {};
  for (const [idx, meta] of caseMetas.entries()) {
    let tag = meta[0];
    caseLookup[tag] = { discriminant: idx, meta };
  }
  
  return function _lowerFlatVariantInner(ctx) {
    _debugLog('[_lowerFlatVariant()] args', { ctx });
    
    const { tag, val } = ctx.vals[0];
    const variantCase = caseLookup[tag];
    if (!variantCase) {
      throw new Error(`missing tag [${tag}] (valid tags: ${Object.keys(caseLookup)})`);
    }
    
    const [ _tag, lowerFn, caseSize32, caseAlign32, caseFlatCount ] = variantCase.meta;
    
    const originalPtr = ctx.storagePtr;
    ctx.vals = [variantCase.discriminant];
    let discLowerRes;
    if (caseMetas.length < 256) {
      discLowerRes = _lowerFlatU8(ctx);
    } else if (caseMetas.length >= 256 && caseMetas.length < 65536) {
      discLowerRes = _lowerFlatU16(ctx);
    } else if (caseMetas.length >= 65536 && caseMetas.length < 4_294_967_296) {
      discLowerRes = _lowerFlatU32(ctx);
    } else {
      throw new Error(`unsupported number of cases [${caseMetas.length}]`);
    }
    
    const payloadOffsetPtr = originalPtr + variantPayloadOffset32;
    ctx.storagePtr = payloadOffsetPtr;
    ctx.vals = [val];
    if (lowerFn) { lowerFn(ctx); }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + variantSize32);
    
    const rem = ctx.storagePtr % variantAlign32;
    if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
  }
}

function _lowerFlatEnum(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatEnumInner(ctx) {
    _debugLog('[_lowerFlatEnum()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotEnumObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v);
    if (isNotEnumObject) {
      ctx.vals[0] = { tag: v };
    }
    
    f(ctx);
  }
}

function _lowerFlatOption(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatOptionInner(ctx) {
    _debugLog('[_lowerFlatOption()] args', { ctx });
    
    const v = ctx.vals[0];
    if (v === null || v === undefined) {
      ctx.vals[0] = { tag: 'none' };
    } else {
      const isNotOptionObject = typeof v !== 'object'
      || Object.keys(v).length !== 2
      || !('tag' in v)
      || !(v.tag === 'some' || v.tag === 'none')
      || !('val' in v);
      if (isNotOptionObject) {
        ctx.vals[0] = { tag: 'some', val: v };
      }
    }
    
    f(ctx);
  }
}

function _lowerFlatResult(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatResultInner(ctx) {
    _debugLog('[_lowerFlatResult()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotResultObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v)
    || !('ok' === v.tag || 'err' === v.tag)
    || !('val' in v);
    if (isNotResultObject) {
      ctx.vals[0] = { tag: 'ok', val: v };
    }
    
    f(ctx);
  };
}

function _lowerFlatOwn(meta) {
  const { lowerFn, componentIdx } = meta;
  
  return function _lowerFlatOwnInner(ctx) {
    _debugLog('[_lowerFlatOwn()] args', { ctx });
    const { createFn } = ctx;
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error(`component index mismatch (expected [${componentIdx}], lift called from [${ctx.componentIdx}])`);
    }
    
    const obj = ctx.vals[0];
    if (obj === undefined || obj === null) { throw new Error('missing resource'); }
    const handle = lowerFn(obj);
    
    ctx.vals[0] = handle;
    _lowerFlatU32(ctx);
  };
}

const STREAMS = new RepTable({ target: 'global stream map' });

const STREAM_TABLES = {};

class StreamEnd {
  static CopyResult = {
    COMPLETED: 0,
    DROPPED: 1,
    CANCELLED: 2,
  };
  
  static CopyState = {
    IDLE: 1,
    SYNC_COPYING: 2,
    ASYNC_COPYING: 3,
    CANCELLING_COPY: 4,
    DONE: 5,
  };
  
  #waitable = null;
  
  #tableIdx = null; // stream table that contains the stream end
  #idx = null; // stream end index in the table
  
  #componentIdx = null;
  
  #copyState = StreamEnd.CopyState.IDLE;
  
  #dropped;
  #setDroppedFn;
  #isDroppedFn;
  
  target;
  
  constructor(args) {
    const { tableIdx, componentIdx } = args;
    if (tableIdx === undefined || typeof tableIdx !== 'number') {
      throw new TypeError(`missing table idx [${tableIdx}]`);
    }
    if (tableIdx < 0 || tableIdx > 2_147_483_647) {
      throw new TypeError(`invalid  tableIdx [${tableIdx}]`);
    }
    if (!args.waitable) { throw new Error('missing/invalid waitable'); }
    
    this.#tableIdx = args.tableIdx;
    this.#waitable = args.waitable;
    
    if (args.setDroppedFn && args.isDroppedFn) {
      this.#setDroppedFn = args.setDroppedFn;
      this.#isDroppedFn = args.isDroppedFn;
    } else if (args.setDroppedFn === undefined && args.isDroppedFn === undefined) {
      this.#setDroppedFn = (v) => { this.#dropped = v; };
      this.#isDroppedFn = () => { return this.#dropped; };
    } else {
      throw new TypeError('setDroppedFn and isDroppedFn must both be specified or neither');
    }
    
    this.target = args.target;
  }
  
  tableIdx() { return this.#tableIdx; }
  
  idx() { return this.#idx; }
  setIdx(idx) { this.#idx = idx; }
  
  setTarget(tgt) { this.target = tgt; }
  
  getWaitable() { return this.#waitable; }
  setWaitable(w) { this.#waitable = w; }
  
  setCopyState(state) { this.#copyState = state; }
  getCopyState() { return this.#copyState; }
  
  isCopying() {
    switch (this.#copyState) {
      case StreamEnd.CopyState.IDLE:
      case StreamEnd.CopyState.DONE:
      return false;
      break;
      case StreamEnd.CopyState.SYNC_COPYING:
      case StreamEnd.CopyState.ASYNC_COPYING:
      case StreamEnd.CopyState.CANCELLING_COPY:
      return true;
      break;
      default:
      throw new Error('invalid/unknown copying state');
    }
  }
  
  setPendingEvent(fn) {
    if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
    _debugLog('[StreamEnd#setPendingEvent()]', {
      waitable: this.#waitable,
      waitableinSet: this.#waitable.isInSet(),
      componentIdx: this.#waitable.componentIdx(),
    });
    this.#waitable.setPendingEvent(fn);
  }
  
  hasPendingEvent() {
    if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
    return this.#waitable.hasPendingEvent();
  }
  
  isInSet() {
    if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
    return this.#waitable.isInSet();
  }
  
  getPendingEvent() {
    if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
    _debugLog('[StreamEnd#getPendingEvent()]', {
      waitable: this.#waitable,
      waitableinSet: this.#waitable.isInSet(),
      componentIdx: this.#waitable.componentIdx(),
    });
    const event = this.#waitable.getPendingEvent();
    return event;
  }
  
  isDropped() { return this.#isDroppedFn(); }
  setDropped() { return this.#setDroppedFn(); }
  
  drop(opts = {}) {
    _debugLog('[StreamEnd#drop()]', {
      waitable: this.#waitable,
      waitableinSet: this.#waitable.isInSet(),
      componentIdx: this.#waitable.componentIdx(),
    });
    
    if (this.isDropped()) {
      _debugLog('[StreamEnd#drop()] already dropped', {
        waitable: this.#waitable,
        waitableinSet: this.#waitable.isInSet(),
        componentIdx: this.#waitable.componentIdx(),
      });
      return;
    }
    
    this.setDropped();
    if (this.#waitable) {
      const w = this.#waitable;
      if (opts.allowPendingEvent) {
        // A lifted host read can still be observing this event.
        // Detach it from any guest waitable set, but leave the
        // event available for the in-flight host read to consume.
        w.join(null);
      } else {
        w.drop();
      }
    }
  }
}

class ManagedBuffer {
  static MAX_LENGTH = 2**28 - 1;
  #componentIdx;
  #memory;
  
  #elemMeta = null;
  
  #start;
  #ptr;
  capacity;
  processed = 0;
  
  #hostOnlyData; // initial data (only filled out for host-owned)
  
  target;
  
  constructor(args) {
    if (args.capacity > ManagedBuffer.MAX_LENGTH) {
      throw new Error(`buffer size [${args.capacity}] greater than max length`);
    }
    if (args.componentIdx === undefined) { throw new TypeError('missing/invalid component idx'); }
    if (args.capacity === undefined) { throw new TypeError('missing/invalid capacity'); }
    if (!args.elemMeta || typeof args.elemMeta.align32 !== 'number') {
      throw new TypeError('missing/invalid element metadata');
    }
    
    if (!args.memory && args.start === undefined && args.data === undefined) {
      throw new TypeError('either memory and start ptr or data must be provided for managed buffers');
    }
    
    if (args.memory && args.start == undefined) {
      throw new TypeError('missing/invalid start ptr, depsite memory being present');
    }
    
    if (!args.elemMeta.isNone && args.capacity > 0) {
      if (args.start && args.start % args.elemMeta.align32 !== 0) {
        throw new Error(`invalid alignment: type with 32bit alignment [${args.elemMeta.align32}] at starting pointer [${args.start}]`);
      }
      // TODO: memory lenght bounds check
    }
    
    this.#componentIdx = args.componentIdx;
    this.#memory = args.memory;
    this.#start = args.start;
    this.#ptr = this.#start;
    this.capacity = args.capacity;
    this.#elemMeta = args.elemMeta;
    
    if (args.data !== undefined && !Array.isArray(args.data)) {
      throw new TypeError('host-only data must be an array');
    }
    this.#hostOnlyData = args.data;
    
    this.target = args.target;
  }
  
  setTarget(tgt) { this.target = tgt; }
  
  remaining() {
    return this.capacity - this.processed;
  }
  
  componentIdx() { return this.#componentIdx; }
  
  getElemMeta() { return this.#elemMeta; }
  
  isHostOwned() { return !this.#memory; }
  
  read(count) {
    _debugLog('[ManagedBuffer#read()] args', { count });
    if (count === undefined || count <= 0) {
      throw new TypeError(`missing/invalid count [${count}]`);
    }
    
    const cap = this.capacity;
    if (count > cap) {
      throw new Error(`cannot read [${count}] elements from buffer with capacity [${cap}]`);
    }
    
    let values = [];
    if (this.#elemMeta.isNone) {
      values = [...new Array(count)].map(() => null);
    } else {
      if (this.isHostOwned()) {
        values = this.#hostOnlyData.slice(0, count);
        this.#hostOnlyData = this.#hostOnlyData.slice(count);
      } else if (this.#elemMeta.payloadTypeName === 'U8') {
        values = Array.from(new Uint8Array(this.#memory.buffer, this.#ptr, count));
        this.#ptr += count;
      } else {
        let currentCount = count;
        let startPtr = this.#ptr;
        if (this.#elemMeta.stringEncoding === undefined) {
          throw new Error('string encoding unknown during read');
        }
        let liftCtx = {
          storagePtr: startPtr,
          memory: this.#memory,
          componentIdx: this.#componentIdx,
          stringEncoding: this.#elemMeta.stringEncoding,
        };
        if (currentCount < 0) { throw new Error('unexpectedly invalid count'); }
        while (currentCount > 0) {
          const [value, _ctx] = this.#elemMeta.liftFn(liftCtx);
          values.push(value);
          currentCount -= 1;
        }
        this.#ptr = liftCtx.storagePtr;
      }
    }
    
    this.processed += count;
    return values;
  }
  
  write(values) {
    _debugLog('[ManagedBuffer#write()] args', { values });
    
    if (!Array.isArray(values)) { throw new TypeError('values input to write() must be an array'); }
    let rc = this.remaining();
    if (values.length > rc) {
      throw new Error(`cannot write [${values.length}] elements to managed buffer with remaining capacity [${rc}]`);
    }
    
    if (this.#elemMeta.isNone) {
      if (!values.every(v => v === null)) {
        throw new Error('non-null values in write() to unit managed buffer');
      }
    } else {
      if (this.isHostOwned()) {
        this.#hostOnlyData = this.#hostOnlyData.concat(values);
      } else if (this.#elemMeta.payloadTypeName === 'U8') {
        new Uint8Array(this.#memory.buffer, this.#ptr, values.length).set(values);
        this.#ptr += values.length;
      } else {
        let startPtr = this.#ptr;
        if (this.#elemMeta.stringEncoding === undefined) {
          throw new Error('string encoding unknown during write');
        }
        
        const lowerCtx = {
          memory: this.#memory,
          storagePtr: startPtr,
          componentIdx: this.#componentIdx,
          stringEncoding: this.#elemMeta.stringEncoding,
          realloc: this.#elemMeta.getReallocFn?.(),
          getReallocFn: this.#elemMeta.getReallocFn,
        }
        for (const v of values) {
          lowerCtx.vals = [v];
          this.#elemMeta.lowerFn(lowerCtx);
        }
        
        this.#ptr = lowerCtx.storagePtr;
      }
    }
    
    this.processed += values.length;
  }
  
}

class BufferManager {
  #buffers = new Map();
  #bufferIDs = new Map();
  
  // NOTE: componentIdx === -1 indicates the host
  getNextBufferID(componentIdx) {
    const current = this.#bufferIDs.get(componentIdx);
    if (current === undefined) {
      this.#bufferIDs.set(componentIdx, 1n);
      return 1n;
    }
    const next = current + 1n;
    this.#bufferIDs.set(componentIdx, next);
    return next;
  }
  
  getBuffer(componentIdx, bufferID) {
    _debugLog('[BufferManager#getBuffer()] args', { componentIdx, bufferID });
    return this.#buffers.get(componentIdx)?.get(bufferID);
  }
  
  createBuffer(args) {
    _debugLog('[BufferManager#createBuffer()] args', args);
    if (!args || typeof args !== 'object') { throw new TypeError('missing/invalid argument object'); }
    
    if (args.start === undefined && args.data === undefined) {
      throw new  TypeError('either a starting pointer or initial values must be provided');
    }
    
    if (args.start !== undefined && args.componentIdx === undefined) { throw new TypeError('missing/invalid component idx'); }
    if (args.count === undefined) { throw new TypeError('missing/invalid obj count'); }
    if (!args.elemMeta) { throw new TypeError('missing/invalid element metadata for use with managed buffer'); }
    
    const { componentIdx, data, start, count } = args;
    
    if (!this.#buffers.has(componentIdx)) { this.#buffers.set(componentIdx, new Map()); }
    const instanceBuffers = this.#buffers.get(componentIdx);
    
    const nextBufID = this.getNextBufferID(componentIdx);
    
    const buffer = new ManagedBuffer({
      componentIdx,
      memory: args.memory,
      start: args.start,
      capacity: args.count,
      elemMeta: args.elemMeta,
      data: args.data,
      target: args.target,
      stringEncoding: args.stringEncoding,
    });
    
    if (instanceBuffers.has(nextBufID)) {
      throw new Error(`managed buffer with ID [${nextBufID}] already exists`);
    }
    instanceBuffers.set(nextBufID, buffer);
    
    return { id: nextBufID, buffer };
  }
  
  deleteBuffer(componentIdx, bufferID) {
    _debugLog('[BufferManager#deleteBuffer()] args', { componentIdx, bufferID });
    return this.#buffers.get(componentIdx)?.delete(bufferID);
  }
  
}
const BUFFER_MGR = new BufferManager();
class StreamReadableEnd extends StreamEnd {
  #copying = false;
  #done = false;
  
  #elemMeta = null;
  // held by both write and read ends
  #pendingBufferMeta = null;
  
  // table index that the stream is in (can change after a stream transfer)
  #streamTableIdx;
  // handle (index) inside the given table (can change after a stream transfer)
  #handle;
  
  // internal stream (which has both ends) rep
  #globalStreamMapRep;
  
  // only populated for lowered (read) stream ends
  #hostInjectFn;
  #hostDropFn;
  #hostCancelFn;
  // only populated for the write side of a lowered read stream end
  #isHostOwned;
  
  #result = null;
  
  #endOfStream = false;
  #rejectedLength = null;
  
  constructor(args) {
    _debugLog('[StreamReadableEnd#constructor()] args', args);
    super(args);
    
    if (!args.elemMeta) { throw new Error('missing/invalid element meta'); }
    this.#elemMeta = args.elemMeta;
    
    if (!args.pendingBufferMeta) { throw new Error('missing/invalid shared pending buffer meta'); }
    this.#pendingBufferMeta = args.pendingBufferMeta;
    
    if (args.tableIdx === undefined) { throw new Error('missing index for stream table idx'); }
    this.#streamTableIdx = args.tableIdx;
    
    this.#hostInjectFn = args.hostInjectFn;
    this.#isHostOwned = args.hostOwned;
  }
  
  streamTableIdx() { return this.#streamTableIdx; }
  setStreamTableIdx(idx) { this.#streamTableIdx = idx; }
  
  handle() { return this.#handle; }
  setHandle(h) { this.#handle = h; }
  
  globalStreamMapRep() { return this.#globalStreamMapRep; }
  setGlobalStreamMapRep(rep) { this.#globalStreamMapRep = rep; }
  
  waitableIdx() { return this.getWaitable().idx(); }
  setWaitableIdx(idx) {
    const w = this.getWaitable();
    w.setIdx(idx);
    w.setTarget(`waitable for read end (waitable [${idx}])`);
  }
  
  setHostInjectFn(f) {
    if (this.#hostInjectFn) { throw new Error('host injection fn is already set'); }
    this.#hostInjectFn = f;
  }
  setHostDropFn(f) {
    if (this.#hostDropFn) { throw new Error('host drop fn is already set'); }
    this.#hostDropFn = f;
  }
  setHostCancelFn(f) { this.#hostCancelFn = f; }
  
  getElemMeta() { return {...this.#elemMeta}; }
  
  
  isReadable() { return true; }
  isWritable() { return false; }
  
  
  isDoneState() { return this.getCopyState() === StreamEnd.CopyState.DONE; }
  isCancelledState() { return this.getCopyState() === StreamEnd.CopyState.CANCELLED; }
  isIdleState() { return this.getCopyState() === StreamEnd.CopyState.IDLE; }
  
  
  async read(opts = 1) {
    _debugLog('[StreamReadableEnd#read()]');
    
    if (this.#endOfStream) {
      return { value: undefined, done: true };
    }
    let { count, rejectLength } = this.#readOpts(opts);
    
    // Wait for an existing read operation to end, if present,
    // otherwise register this read for any future operations.
    //
    // NOTE: this complexity below is an attempt to sequence operations
    // to ensure consecutive reads only wait on their direct predecessors,
    // (i.e. read #3 must wait on read #2, *not* read #1)
    //
    const newResult = promiseWithResolvers();
    if (this.#result) {
      try {
        const p = this.#result.promise;
        this.#result = newResult;
        await p;
      } catch (err) {
        _debugLog('[StreamReadableEnd#read()] error waiting for previous read', err);
        // If the previous write we were waiting on errors for any reason,
        // we can ignore it and attempt to continue with this read
        // which may also fail for a similar reason
      }
    } else {
      this.#result = newResult;
    }
    const { promise, resolve, reject } = newResult;
    
    // TODO(fix): when we do a read, we need to GET the string encoding from the
    // other side, via the lift/lower fn?
    
    count = Math.min(count, ManagedBuffer.MAX_LENGTH);
    try {
      const { id: bufferID, buffer } = BUFFER_MGR.createBuffer({
        componentIdx: -1, // componentIdx of -1 indicates the host
        count,
        isReadable: false,
        isWritable: true, // we need to write out the pending buffer (if present)
        elemMeta: this.#elemMeta,
        data: [],
      });
      buffer.setTarget(`host stream read buffer (id [${bufferID}], count [${count}])`);
      
      let packedResult;
      packedResult = await this.copy({
        isAsync: true,
        count,
        bufferID,
        buffer,
        eventCode: ASYNC_EVENT_CODE.STREAM_READ,
        componentIdx: -1,
        rejectLength,
      });
      
      if (packedResult === ASYNC_BLOCKED_CODE) {
        // If the read was blocked, the pending event produced by the
        // write side represents the completed copy.
        
        await new Promise((resolve) => {
          let waitInterval = setInterval(() => {
            if (!this.hasPendingEvent()) { return; }
            clearInterval(waitInterval);
            resolve();
          });
        });
        
        if (!this.hasPendingEvent()) {
          throw new Error("missing pending event after blocked stream read");
        }
        
        const event = this.getPendingEvent();
        if (!event) { throw new Error("missing pending event after blocked stream read"); }
        
        const { code, payload0: index, payload1: payload } = event;
        
        if (code !== ASYNC_EVENT_CODE.STREAM_READ) {
          throw new Error(`mismatched event code [${code}] for host stream read`);
        }
        
        if (index !== this.waitableIdx()) { throw new Error('invalid stream end index'); }
        if (event.rejectedLength !== undefined) {
          this.#rejectedLength = event.rejectedLength;
        }
        packedResult = payload;
        
        if (packedResult === ASYNC_BLOCKED_CODE) {
          throw new Error("unexpected double block during read");
        }
      }
      
      const resultKind = packedResult & 0xF;
      const transferred = packedResult >> 4;
      
      // The copy event is published from inside the guest's current
      // callback slice. Do not expose lifted values to host code until
      // that slice has returned and released the instance lock: the
      // consumer may immediately make a synchronous call on a lifted
      // resource, which cannot itself wait for a contended lock.
      const componentIdx = this.getWaitable().componentIdx();
      if (componentIdx !== -1) {
        await getOrCreateAsyncState(componentIdx).waitForExclusiveRelease();
      }
      
      if (resultKind === StreamEnd.CopyResult.DROPPED) {
        this.#endOfStream = true;
      }
      
      if (transferred > 0) {
        const values = buffer.read(transferred);
        const { typedArray } = this.#elemMeta;
        const value = typedArray === undefined ? count === 1 ? values[0] : values : new typedArray(values);
        this.#result = null;
        resolve(value);
      } else {
        this.#result = null;
        resolve(undefined);
      }
      
    } catch (err) {
      _debugLog('[StreamReadableEnd#read()] error', err);
      reject(err);
    }
    
    const res = await promise;
    const rejectedLength = this.#rejectedLength;
    this.#rejectedLength = null;
    const result = { value: res, done: res === undefined };
    if (rejectedLength !== null) {
      result.rejectedLength = rejectedLength;
    }
    return result;
  }
  
  #readOpts(opts) {
    const count = opts === undefined ? 1 : typeof opts === "number" ? opts : opts && typeof opts === "object" ? opts.count ?? 1 : undefined;
    const rejectLength = opts && typeof opts === "object" ? opts.rejectLength : undefined;
    if (!Number.isInteger(count) || count < (rejectLength !== undefined ? 0 : 1)) {
      throw new TypeError(`invalid stream read count [${count}]`);
    }
    if (rejectLength !== undefined && (!Number.isInteger(rejectLength) || rejectLength < 0)) {
      throw new TypeError(`invalid stream read reject length [${rejectLength}]`);
    }
    return { count, rejectLength };
  }
  
  
  _read(args) {
    const { buffer, onCopyDoneFn, onCopyFn, componentIdx, rejectLength } = args;
    if (this.isDropped()) {
      onCopyDoneFn(StreamEnd.CopyResult.DROPPED);
      return;
    }
    
    if (!this.#pendingBufferMeta.buffer) {
      this.setPendingBufferMeta({
        componentIdx,
        buffer,
        onCopyFn,
        onCopyDoneFn,
        rejectLength,
      });
      return;
    }
    
    const pendingElemMeta = this.#pendingBufferMeta.buffer.getElemMeta();
    const newBufferElemMeta = buffer.getElemMeta();
    if (pendingElemMeta.payloadTypeName !== newBufferElemMeta.payloadTypeName) {
      throw new WebAssemblyRuntimeError("stream end type does not match internal buffer");
    }
    
    // Since we do not know the string encoding until a write is performed, it is possible that
    // one end (i.e. the read end) does not yet know the appropriate string encoding to use when
    // lifting/lowering.
    if (newBufferElemMeta.stringEncoding === undefined || pendingElemMeta.stringEncoding === undefined) {
      const encoding = pendingElemMeta.stringEncoding ?? newBufferElemMeta.stringEncoding;
      if (encoding === undefined) { throw new Error('both writer & reader missing string encoding'); }
      newBufferElemMeta.stringEncoding = encoding;
      pendingElemMeta.stringEncoding = encoding;
    }
    
    // If the buffer came from the same component that is currently doing the operation
    // we're doing a inter-component read, and only unit or numeric types are allowed
    const pendingElemIsNoneOrNumeric = pendingElemMeta.isNone || pendingElemMeta.isNumeric;
    if (this.#pendingBufferMeta.componentIdx === buffer.componentIdx() && buffer.componentIdx() !== -1 && !pendingElemIsNoneOrNumeric) {
      throw new WebAssemblyRuntimeError(`cannot stream non-numeric types within the same component (component [${buffer.componentIdx()}] read)`);
    }
    
    const pendingRemaining = this.#pendingBufferMeta.buffer.remaining();
    let transferred = false;
    if (pendingRemaining > 0) {
      const bufferRemaining = buffer.remaining();
      if (rejectLength !== undefined && pendingRemaining > rejectLength) {
        this.resetAndNotifyPending(StreamEnd.CopyResult.DROPPED);
        onCopyDoneFn(StreamEnd.CopyResult.DROPPED, pendingRemaining);
        return;
      }
      if (bufferRemaining > 0) {
        const count = Math.min(pendingRemaining, bufferRemaining);
        buffer.write(this.#pendingBufferMeta.buffer.read(count))
        this.#pendingBufferMeta.onCopyFn(() => this.resetPendingBufferMeta());
        transferred = true;
      }
      
      onCopyDoneFn(StreamEnd.CopyResult.COMPLETED);
      
      return;
    }
    
    this.resetAndNotifyPending(StreamEnd.CopyResult.COMPLETED);
    this.setPendingBufferMeta({ componentIdx, buffer, onCopyFn, onCopyDoneFn, rejectLength });
  }
  
  
  setupCopy(args) {
    const {
      memory,
      ptr,
      count,
      eventCode,
      componentIdx,
      skipStateCheck,
    } = args;
    if (eventCode === undefined) { throw new Error("missing/invalid event code"); }
    
    let buffer = args.buffer;
    let bufferID = args.bufferID;
    
    // Only check invariants if we are *not* doing a follow-up/post-blocked read
    if (!skipStateCheck) {
      if (this.isCopying()) {
        throw new Error('stream is currently undergoing a separate copy');
      }
      if (this.getCopyState() !== StreamEnd.CopyState.IDLE) {
        throw new Error(`stream copy state is not idle`);
      }
    }
    
    const elemMeta = this.getElemMeta();
    if (elemMeta.isBorrowed) { throw new Error('borrowed types cannot be sent over streams'); }
    
    // If we already have a managed buffer (likely host case), we can use that, otherwise we must
    // create a buffer (likely in the guest case)
    if (!buffer) {
      const newBufferMeta = BUFFER_MGR.createBuffer({
        componentIdx,
        memory,
        start: ptr,
        count,
        // If creating a buffer for a write operation, the buffer we are encapsulating
        // is a *readable* buffer from the view of the component (as it has written to that buffer data that)
        // should be sent out
        isReadable: this.isWritable(),
        // If creating a buffer for a read operation, the buffer we are encapsulating
        // is a *writable* buffer from the view of the component (as it has prepared space to receive data)
        isWritable: this.isReadable(),
        elemMeta,
      });
      bufferID = newBufferMeta.id;
      buffer = newBufferMeta.buffer;
      buffer.setTarget(`component [${componentIdx}] StreamReadableEnd buffer (id [${bufferID}], count [${count}], eventCode [${eventCode}])`);
    }
    
    const streamEnd = this;
    const processFn = (result, reclaimBufferFn, rejectedLength) => {
      if (reclaimBufferFn) { reclaimBufferFn(); }
      
      if (result === StreamEnd.CopyResult.DROPPED) {
        streamEnd.setCopyState(StreamEnd.CopyState.DONE);
      } else {
        streamEnd.setCopyState(StreamEnd.CopyState.IDLE);
      }
      
      if (result < 0 || result >= 16) {
        throw new Error(`unsupported stream copy result [${result}]`);
      }
      if (buffer.processed >= ManagedBuffer.MAX_LENGTH) {
        throw new Error(`processed count [${buf.length}] greater than max length`);
      }
      if (buffer.length > 2**28) { throw new Error('buffer uses reserved space'); }
      
      const packedResult = (Number(buffer.processed) << 4) | result;
      const event = { code: eventCode, payload0: streamEnd.waitableIdx(), payload1: packedResult };
      if (rejectedLength !== undefined) {
        event.rejectedLength = rejectedLength;
      }
      
      return event;
    };
    
    const onCopyFn = (reclaimBufferFn) => {
      streamEnd.setPendingEvent(() => {
        return processFn(StreamEnd.CopyResult.COMPLETED, reclaimBufferFn);
      });
    };
    
    const onCopyDoneFn = (result, rejectedLength) => {
      streamEnd.setPendingEvent(() => {
        return processFn(result, undefined, rejectedLength);
      });
    };
    
    return { bufferID, buffer, onCopyFn, onCopyDoneFn };
  }
  
  
  async copy(args) {
    const {
      isAsync,
      memory,
      componentIdx,
      ptr,
      count,
      eventCode,
      initial,
      skipStateCheck,
      stringEncoding,
      reallocFn,
      rejectLength,
    } = args;
    if (eventCode === undefined) { throw new TypeError('missing/invalid event code'); }
    
    if (this.#elemMeta.stringEncoding === undefined && stringEncoding) {
      this.#elemMeta.stringEncoding = stringEncoding;
    }
    if (this.#elemMeta.stringEncoding && stringEncoding && this.#elemMeta.stringEncoding !== stringEncoding) {
      throw new Error(`inconsistent string encoding (previously [${this.#elemMeta.stringEncoding}], now [${stringEncoding}])`);
    }
    
    if (args.getReallocFn && this.#elemMeta.getReallocFn === undefined) {
      this.#elemMeta.getReallocFn = args.getReallocFn;
    }
    
    if (this.isDropped()) {
      if (this.#pendingBufferMeta?.onCopyDoneFn) {
        const f = this.#pendingBufferMeta.onCopyDoneFn;
        this.#pendingBufferMeta.onCopyDoneFn = null;
        f(StreamEnd.CopyResult.DROPPED);
      }
      this.setCopyState(StreamEnd.CopyState.DONE);
      return StreamEnd.CopyResult.DROPPED;
    }
    
    const { buffer, onCopyFn, onCopyDoneFn } = this.setupCopy({
      memory,
      eventCode,
      componentIdx,
      ptr,
      count,
      buffer: args.buffer,
      bufferID: args.bufferID,
      initial,
      skipStateCheck,
    });
    
    // If the stream is readable and was lowered from the host, the
    // writer is host-side. Register the read first; host injection
    // will no-op if the read already produced a pending event.
    const injectHostWrite = this.isReadable() && !!this.#hostInjectFn;
    
    // Perform the read/write
    this._read({
      buffer,
      onCopyFn,
      onCopyDoneFn,
      componentIdx,
      rejectLength,
    });
    
    let injectedWritePromise;
    if (injectHostWrite) {
      injectedWritePromise = this.#hostInjectFn({ count });
    }
    
    // If sync, wait forever but allow task to do other things
    if (!this.hasPendingEvent()) {
      if (isAsync) {
        this.setCopyState(StreamEnd.CopyState.ASYNC_COPYING);
        _debugLog('[StreamEnd#copy()] blocked', { componentIdx, eventCode, self: this });
        if (injectedWritePromise) {
          // Do not await here: the injected write may depend on sibling
          // guest work running, so the canonical read must return BLOCKED.
          injectedWritePromise.then(
          cleanupFn => cleanupFn(),
          err => this.setPendingEvent(() => { throw err; }),
          );
        }
        return ASYNC_BLOCKED_CODE;
      } else {
        this.setCopyState(StreamEnd.CopyState.SYNC_COPYING);
        
        const taskMeta = getCurrentTask(componentIdx);
        if (!taskMeta) { throw new Error(`missing task meta for component idx [${componentIdx}]`); }
        
        const task = taskMeta.task;
        if (!task) { throw new Error('missing task task from task meta'); }
        
        const streamEnd = this;
        await task.suspendUntil({
          readyFn: () => streamEnd.hasPendingEvent(),
        });
      }
    }
    
    // If the read completed immediately after injecting a host write,
    // it is safe to await injection cleanup before consuming the event.
    if (injectedWritePromise) {
      const cleanupFn = await injectedWritePromise;
      cleanupFn();
    }
    
    const event = this.getPendingEvent();
    if (!event) { throw new Error("unexpectedly missing pending event"); }
    if (event.code === undefined || event.payload0 === undefined || event.payload1 === undefined) {
      throw new Error("unexpectedly malformed event");
    }
    
    const { code, payload0: index, payload1: payload } = event;
    
    const waitableIdx = this.getWaitable().idx();
    if (code !== eventCode  || index !== waitableIdx || payload === ASYNC_BLOCKED_CODE) {
      const errMsg = "invalid event code/event during stream operation";
      _debugLog(errMsg, {
        event,
        payload,
        payloadIsBlockedConst: payload === ASYNC_BLOCKED_CODE,
        code,
        eventCode,
        codeDoesNotMatchEventCode: code !== eventCode,
        index,
        internalEndIdx: waitableIdx,
        indexDoesNotMatch: index !== waitableIdx,
      });
      throw new Error(errMsg);
    }
    
    if (event.rejectedLength !== undefined) {
      this.#rejectedLength = event.rejectedLength;
    }
    return payload;
  }
  
  
  setPendingBufferMeta(args) {
    const { componentIdx, buffer, onCopyFn, onCopyDoneFn, rejectLength } = args;
    this.#pendingBufferMeta.componentIdx = componentIdx;
    this.#pendingBufferMeta.buffer = buffer;
    this.#pendingBufferMeta.onCopyFn = onCopyFn;
    this.#pendingBufferMeta.onCopyDoneFn = onCopyDoneFn;
    this.#pendingBufferMeta.rejectLength = rejectLength;
  }
  
  resetPendingBufferMeta() {
    this.setPendingBufferMeta({ componentIdx: null, buffer: null, onCopyFn: null, onCopyDoneFn: null, rejectLength: undefined });
  }
  
  getPendingBufferMeta() { return this.#pendingBufferMeta; }
  
  resetAndNotifyPending(result) {
    const f = this.#pendingBufferMeta.onCopyDoneFn;
    this.resetPendingBufferMeta();
    if (f) { f(result); }
  }
  
  cancel() {
    _debugLog('[StreamEnd#cancel()]');
    const completeCancel = () => {
      if (this.isDropped()) { return; }
      // Host injection may complete the copy before this deferred
      // cancellation runs. Preserve that completion event instead of
      // cancelling the next operation or starting a duplicate write.
      if (this.hasPendingEvent()) { return; }
      if (this.#hostCancelFn?.()) { return; }
      const result = this.#pendingBufferMeta?.buffer?.processed > 0
      ? StreamEnd.CopyResult.COMPLETED
      : StreamEnd.CopyResult.CANCELLED;
      this.resetAndNotifyPending(result);
    };
    if (this.#hostInjectFn) {
      setTimeout(completeCancel, 0);
    } else {
      completeCancel();
    }
  }
  
  drop(opts = {}) {
    _debugLog('[StreamEnd#drop()]');
    if (this.isDropped()) { return; }
    const hostDropFn = this.#hostDropFn;
    this.#hostDropFn = null;
    super.drop(opts);
    if (hostDropFn) {
      // A source drop hook can re-enter the component, so both ends must
      // observe the drop before the hook wakes a waiting writer.
      Promise.resolve(hostDropFn()).catch(err => {
        _debugLog('[StreamEnd#drop()] host drop failed', err);
      });
    }
    if (this.#pendingBufferMeta) {
      const result = this.#pendingBufferMeta.buffer?.processed > 0
      ? StreamEnd.CopyResult.COMPLETED
      : StreamEnd.CopyResult.DROPPED;
      this.resetAndNotifyPending(result);
    }
  }
}

class StreamWritableEnd extends StreamEnd {
  #copying = false;
  #done = false;
  
  #elemMeta = null;
  // held by both write and read ends
  #pendingBufferMeta = null;
  
  // table index that the stream is in (can change after a stream transfer)
  #streamTableIdx;
  // handle (index) inside the given table (can change after a stream transfer)
  #handle;
  
  // internal stream (which has both ends) rep
  #globalStreamMapRep;
  
  // only populated for lowered (read) stream ends
  #hostInjectFn;
  #hostDropFn;
  #hostCancelFn;
  // only populated for the write side of a lowered read stream end
  #isHostOwned;
  
  #result = null;
  
  #endOfStream = false;
  #rejectedLength = null;
  
  constructor(args) {
    _debugLog('[StreamWritableEnd#constructor()] args', args);
    super(args);
    
    if (!args.elemMeta) { throw new Error('missing/invalid element meta'); }
    this.#elemMeta = args.elemMeta;
    
    if (!args.pendingBufferMeta) { throw new Error('missing/invalid shared pending buffer meta'); }
    this.#pendingBufferMeta = args.pendingBufferMeta;
    
    if (args.tableIdx === undefined) { throw new Error('missing index for stream table idx'); }
    this.#streamTableIdx = args.tableIdx;
    
    this.#hostInjectFn = args.hostInjectFn;
    this.#isHostOwned = args.hostOwned;
  }
  
  streamTableIdx() { return this.#streamTableIdx; }
  setStreamTableIdx(idx) { this.#streamTableIdx = idx; }
  
  handle() { return this.#handle; }
  setHandle(h) { this.#handle = h; }
  
  globalStreamMapRep() { return this.#globalStreamMapRep; }
  setGlobalStreamMapRep(rep) { this.#globalStreamMapRep = rep; }
  
  waitableIdx() { return this.getWaitable().idx(); }
  setWaitableIdx(idx) {
    const w = this.getWaitable();
    w.setIdx(idx);
    w.setTarget(`waitable for write end (waitable [${idx}])`);
  }
  
  setHostInjectFn(f) {
    if (this.#hostInjectFn) { throw new Error('host injection fn is already set'); }
    this.#hostInjectFn = f;
  }
  setHostDropFn(f) {
    if (this.#hostDropFn) { throw new Error('host drop fn is already set'); }
    this.#hostDropFn = f;
  }
  setHostCancelFn(f) { this.#hostCancelFn = f; }
  
  getElemMeta() { return {...this.#elemMeta}; }
  
  
  isReadable() { return false; }
  isWritable() { return true; }
  
  
  isDoneState() { return this.getCopyState() === StreamEnd.CopyState.DONE; }
  isCancelledState() { return this.getCopyState() === StreamEnd.CopyState.CANCELLED; }
  isIdleState() { return this.getCopyState() === StreamEnd.CopyState.IDLE; }
  
  
  async write(v) {
    _debugLog('[StreamWritableEnd#write()] args', { v });
    
    let data;
    if (this.#elemMeta.isNumeric) {
      if (v instanceof ArrayBuffer) {
        v = new Uint8Array(v);
      }
      data = Array.isArray(v) || (ArrayBuffer.isView(v) && typeof v.length === 'number') ? Array.from(v) : [v];
    } else {
      data = [v];
    }
    return this.writeMany(data);
  }
  
  async writeMany(values) {
    _debugLog('[StreamWritableEnd#writeMany()] args', { values });
    if (!Array.isArray(values)) { throw new TypeError("writeMany values must be an array"); }
    
    // Wait for an existing write operation to end, if present,
    // otherwise register this write for any future operations.
    //
    // NOTE: this complexity below is an attempt to sequence operations
    // to ensure consecutive writes only wait on their direct predecessors,
    // (i.e. write #3 must wait on write #2, *not* write #1)
    //
    let newResult = promiseWithResolvers();
    if (this.#result && !this.#isHostOwned) {
      try {
        const p = this.#result.promise;
        this.#result = newResult;
        await p;
      } catch (err) {
        _debugLog('[StreamWritableEnd#writeMany()] error waiting for previous write', err);
        // If the previous write we were waiting on errors for any reason,
        // we can ignore it and attempt to continue with this write
        // which may also fail for a similar reason
      }
    } else {
      this.#result = newResult;
    }
    const { promise, resolve, reject } = newResult;
    
    const data = values;
    const count = data.length;
    if (this.#elemMeta.stringEncoding === undefined) {
      this.#elemMeta.string = 'utf8';
    }
    
    try {
      const { id: bufferID, buffer } = BUFFER_MGR.createBuffer({
        componentIdx: -1,
        count,
        isReadable: true, // we need to read from this buffer later
        isWritable: false,
        elemMeta: this.#elemMeta,
        data,
      });
      buffer.setTarget(`host stream write buffer (id [${bufferID}], count [${count}], data len [${data.length}])`);
      
      let packedResult;
      const copyPromise = this.copy({
        isAsync: true,
        count,
        bufferID,
        buffer,
        eventCode: ASYNC_EVENT_CODE.STREAM_WRITE,
        componentIdx: -1,
      });
      if (this.#isHostOwned && this.hasPendingEvent()) {
        // Host owned writes are just-in-time writes for an already pending guest read.
        // The guest read path consumes the pending event, so waiting here can deadlock.
        copyPromise.catch(err => reject(err));
        this.#result = null;
        resolve();
        return await promise;
      }
      packedResult = await copyPromise;
      
      // If we are dealing with a blocked component write operation, we do an immedaite wait
      // on the host side to pause the host until the write can be completed.
      //
      // We do not do this if we're dealing with a host injection,
      // (i.e. a lowered read end into a component does a read() and forces
      // data to be read from the host side), we must signal the write is completed
      // and we are waiting for the read.
      //
      //  In the host injection case, it is OK that the write is blocked, because we
      //  know the read is about to occur (we control the writes to the stream to be
      // just-before reads, no matter what the user does on the other end).
      //
      if (packedResult === ASYNC_BLOCKED_CODE && !this.#isHostOwned) {
        // If the write was blocked, the pending event produced by the
        // read side represents the completed copy.
        
        await new Promise((resolve) => {
          let waitInterval = setInterval(async () => {
            if (!this.hasPendingEvent()) { return; }
            clearInterval(waitInterval);
            resolve();
          });
        });
        
        if (!this.hasPendingEvent()) {
          throw new Error("missing pending event after blocked stream write");
        }
        
        const event = this.getPendingEvent();
        if (!event) { throw new Error("missing pending event after blocked stream write"); }
        
        const { code, payload0: index, payload1: payload } = event;
        
        if (code !== ASYNC_EVENT_CODE.STREAM_WRITE) {
          throw new Error(`mismatched event code [${code}] for host stream write`);
        }
        
        if (index !== this.waitableIdx()) { throw new Error('invalid stream end index'); }
        packedResult = payload;
        
        const copied = packedResult >> 4;
        if (copied === 0 && this.isDoneState()) {
          reject(new Error("read end dropped during write"));
        }
        
        if (packedResult === ASYNC_BLOCKED_CODE) {
          throw new Error("unexpected double block during write");
        }
      }
      
      
      // Host owned writes were not necessarily unblocked, but are always blocked
      // because they happen just-before a component read (via a lowered end).
      //
      // In this case, we cant to declare the copy state back to idle
      // for the next write that is performed, assuming there may be more writes
      // to do.
      //
      // if (this.#hostOwned) {
        //    this.setCopyState(StreamEnd.CopyState.IDLE);
        // }
        
        // If the write was not blocked, we can resolve right away
        this.#result = null;
        resolve();
        
      } catch (err) {
        _debugLog('[StreamWritableEnd#write()] error', err);
        reject(err);
      }
      
      return await promise;
    }
    
    
    _write(args) {
      const { buffer, onCopyFn, onCopyDoneFn, componentIdx } = args;
      if (!buffer) { throw new TypeError('missing/invalid buffer'); }
      if (!onCopyFn) { throw new TypeError("missing/invalid onCopy handler"); }
      if (!onCopyDoneFn) { throw new TypeError("missing/invalid onCopyDone handler"); }
      if (this.isDropped()) {
        onCopyDoneFn(StreamEnd.CopyResult.DROPPED);
        return;
      }
      
      if (!this.#pendingBufferMeta.buffer) {
        this.setPendingBufferMeta({ componentIdx, buffer, onCopyFn, onCopyDoneFn });
        return;
      }
      
      const pendingElemMeta = this.#pendingBufferMeta.buffer.getElemMeta();
      const newBufferElemMeta = buffer.getElemMeta();
      if (pendingElemMeta.payloadTypeName !== newBufferElemMeta.payloadTypeName) {
        throw new WebAssemblyRuntimeError("stream end type does not match internal buffer");
      }
      
      // If the buffer came from the same component that is currently doing the operation
      // we're doing a inter-component write, and only unit or numeric types are allowed
      const pendingElemIsNoneOrNumeric = pendingElemMeta.isNone || pendingElemMeta.isNumeric;
      if (this.#pendingBufferMeta.componentIdx === buffer.componentIdx() && buffer.componentIdx() !== -1 && !pendingElemIsNoneOrNumeric) {
        throw new WebAssemblyRuntimeError(`cannot stream non-numeric types within the same component (component [${buffer.componentIdx()}], send)`);
      }
      
      // If original capacities were zero, we're dealing with a unit stream,
      // a write to the unit stream is instantly copied without any work.
      if (buffer.capacity === 0 && this.#pendingBufferMeta.buffer.capacity === 0) {
        onCopyDoneFn(StreamEnd.CopyResult.COMPLETED);
        return;
      }
      
      // If the internal buffer has no space left to take writes,
      // the write is complete, we must reset and wait for another read
      // to clear up space in the buffer.
      if (this.#pendingBufferMeta.buffer.remaining() === 0) {
        this.resetAndNotifyPending(StreamEnd.CopyResult.COMPLETED);
        this.setPendingBufferMeta({ componentIdx, buffer, onCopyFn, onCopyDoneFn });
        return;
      }
      
      // At this point it is implied that remaining is > 0,
      // so if there is still remaining capacity in the incoming buffer, perform copy of values
      // to the internal buffer from the incoming buffer
      let transferred = false;
      if (buffer.remaining() > 0) {
        const rejectLength = this.#pendingBufferMeta.rejectLength;
        if (rejectLength !== undefined && buffer.remaining() > rejectLength) {
          const pendingOnCopyDoneFn = this.#pendingBufferMeta.onCopyDoneFn;
          this.resetPendingBufferMeta();
          pendingOnCopyDoneFn(StreamEnd.CopyResult.DROPPED, buffer.remaining());
          onCopyDoneFn(StreamEnd.CopyResult.DROPPED);
          return;
        }
        const numElements = Math.min(buffer.remaining(), this.#pendingBufferMeta.buffer.remaining());
        this.#pendingBufferMeta.buffer.write(buffer.read(numElements));
        this.#pendingBufferMeta.onCopyFn(() => this.resetPendingBufferMeta());
        transferred = true;
      }
      
      onCopyDoneFn(StreamEnd.CopyResult.COMPLETED);
    }
    
    
    setupCopy(args) {
      const {
        memory,
        ptr,
        count,
        eventCode,
        componentIdx,
        skipStateCheck,
      } = args;
      if (eventCode === undefined) { throw new Error("missing/invalid event code"); }
      
      let buffer = args.buffer;
      let bufferID = args.bufferID;
      
      // Only check invariants if we are *not* doing a follow-up/post-blocked read
      if (!skipStateCheck) {
        if (this.isCopying()) {
          throw new Error('stream is currently undergoing a separate copy');
        }
        if (this.getCopyState() !== StreamEnd.CopyState.IDLE) {
          throw new Error(`stream copy state is not idle`);
        }
      }
      
      const elemMeta = this.getElemMeta();
      if (elemMeta.isBorrowed) { throw new Error('borrowed types cannot be sent over streams'); }
      
      // If we already have a managed buffer (likely host case), we can use that, otherwise we must
      // create a buffer (likely in the guest case)
      if (!buffer) {
        const newBufferMeta = BUFFER_MGR.createBuffer({
          componentIdx,
          memory,
          start: ptr,
          count,
          // If creating a buffer for a write operation, the buffer we are encapsulating
          // is a *readable* buffer from the view of the component (as it has written to that buffer data that)
          // should be sent out
          isReadable: this.isWritable(),
          // If creating a buffer for a read operation, the buffer we are encapsulating
          // is a *writable* buffer from the view of the component (as it has prepared space to receive data)
          isWritable: this.isReadable(),
          elemMeta,
        });
        bufferID = newBufferMeta.id;
        buffer = newBufferMeta.buffer;
        buffer.setTarget(`component [${componentIdx}] StreamWritableEnd buffer (id [${bufferID}], count [${count}], eventCode [${eventCode}])`);
      }
      
      const streamEnd = this;
      const processFn = (result, reclaimBufferFn, rejectedLength) => {
        if (reclaimBufferFn) { reclaimBufferFn(); }
        
        if (result === StreamEnd.CopyResult.DROPPED) {
          streamEnd.setCopyState(StreamEnd.CopyState.DONE);
        } else {
          streamEnd.setCopyState(StreamEnd.CopyState.IDLE);
        }
        
        if (result < 0 || result >= 16) {
          throw new Error(`unsupported stream copy result [${result}]`);
        }
        if (buffer.processed >= ManagedBuffer.MAX_LENGTH) {
          throw new Error(`processed count [${buf.length}] greater than max length`);
        }
        if (buffer.length > 2**28) { throw new Error('buffer uses reserved space'); }
        
        const packedResult = (Number(buffer.processed) << 4) | result;
        const event = { code: eventCode, payload0: streamEnd.waitableIdx(), payload1: packedResult };
        if (rejectedLength !== undefined) {
          event.rejectedLength = rejectedLength;
        }
        
        return event;
      };
      
      const onCopyFn = (reclaimBufferFn) => {
        streamEnd.setPendingEvent(() => {
          return processFn(StreamEnd.CopyResult.COMPLETED, reclaimBufferFn);
        });
      };
      
      const onCopyDoneFn = (result, rejectedLength) => {
        streamEnd.setPendingEvent(() => {
          return processFn(result, undefined, rejectedLength);
        });
      };
      
      return { bufferID, buffer, onCopyFn, onCopyDoneFn };
    }
    
    
    async copy(args) {
      const {
        isAsync,
        memory,
        componentIdx,
        ptr,
        count,
        eventCode,
        initial,
        skipStateCheck,
        stringEncoding,
        reallocFn,
        rejectLength,
      } = args;
      if (eventCode === undefined) { throw new TypeError('missing/invalid event code'); }
      
      if (this.#elemMeta.stringEncoding === undefined && stringEncoding) {
        this.#elemMeta.stringEncoding = stringEncoding;
      }
      if (this.#elemMeta.stringEncoding && stringEncoding && this.#elemMeta.stringEncoding !== stringEncoding) {
        throw new Error(`inconsistent string encoding (previously [${this.#elemMeta.stringEncoding}], now [${stringEncoding}])`);
      }
      
      if (args.getReallocFn && this.#elemMeta.getReallocFn === undefined) {
        this.#elemMeta.getReallocFn = args.getReallocFn;
      }
      
      if (this.isDropped()) {
        if (this.#pendingBufferMeta?.onCopyDoneFn) {
          const f = this.#pendingBufferMeta.onCopyDoneFn;
          this.#pendingBufferMeta.onCopyDoneFn = null;
          f(StreamEnd.CopyResult.DROPPED);
        }
        this.setCopyState(StreamEnd.CopyState.DONE);
        return StreamEnd.CopyResult.DROPPED;
      }
      
      const { buffer, onCopyFn, onCopyDoneFn } = this.setupCopy({
        memory,
        eventCode,
        componentIdx,
        ptr,
        count,
        buffer: args.buffer,
        bufferID: args.bufferID,
        initial,
        skipStateCheck,
      });
      
      // If the stream is readable and was lowered from the host, the
      // writer is host-side. Register the read first; host injection
      // will no-op if the read already produced a pending event.
      const injectHostWrite = this.isReadable() && !!this.#hostInjectFn;
      
      // Perform the read/write
      this._write({
        buffer,
        onCopyFn,
        onCopyDoneFn,
        componentIdx,
        rejectLength,
      });
      
      let injectedWritePromise;
      if (injectHostWrite) {
        injectedWritePromise = this.#hostInjectFn({ count });
      }
      
      // If sync, wait forever but allow task to do other things
      if (!this.hasPendingEvent()) {
        if (isAsync) {
          this.setCopyState(StreamEnd.CopyState.ASYNC_COPYING);
          _debugLog('[StreamEnd#copy()] blocked', { componentIdx, eventCode, self: this });
          if (injectedWritePromise) {
            // Do not await here: the injected write may depend on sibling
            // guest work running, so the canonical read must return BLOCKED.
            injectedWritePromise.then(
            cleanupFn => cleanupFn(),
            err => this.setPendingEvent(() => { throw err; }),
            );
          }
          return ASYNC_BLOCKED_CODE;
        } else {
          this.setCopyState(StreamEnd.CopyState.SYNC_COPYING);
          
          const taskMeta = getCurrentTask(componentIdx);
          if (!taskMeta) { throw new Error(`missing task meta for component idx [${componentIdx}]`); }
          
          const task = taskMeta.task;
          if (!task) { throw new Error('missing task task from task meta'); }
          
          const streamEnd = this;
          await task.suspendUntil({
            readyFn: () => streamEnd.hasPendingEvent(),
          });
        }
      }
      
      // If the read completed immediately after injecting a host write,
      // it is safe to await injection cleanup before consuming the event.
      if (injectedWritePromise) {
        const cleanupFn = await injectedWritePromise;
        cleanupFn();
      }
      
      const event = this.getPendingEvent();
      if (!event) { throw new Error("unexpectedly missing pending event"); }
      if (event.code === undefined || event.payload0 === undefined || event.payload1 === undefined) {
        throw new Error("unexpectedly malformed event");
      }
      
      const { code, payload0: index, payload1: payload } = event;
      
      const waitableIdx = this.getWaitable().idx();
      if (code !== eventCode  || index !== waitableIdx || payload === ASYNC_BLOCKED_CODE) {
        const errMsg = "invalid event code/event during stream operation";
        _debugLog(errMsg, {
          event,
          payload,
          payloadIsBlockedConst: payload === ASYNC_BLOCKED_CODE,
          code,
          eventCode,
          codeDoesNotMatchEventCode: code !== eventCode,
          index,
          internalEndIdx: waitableIdx,
          indexDoesNotMatch: index !== waitableIdx,
        });
        throw new Error(errMsg);
      }
      
      if (event.rejectedLength !== undefined) {
        this.#rejectedLength = event.rejectedLength;
      }
      return payload;
    }
    
    
    setPendingBufferMeta(args) {
      const { componentIdx, buffer, onCopyFn, onCopyDoneFn, rejectLength } = args;
      this.#pendingBufferMeta.componentIdx = componentIdx;
      this.#pendingBufferMeta.buffer = buffer;
      this.#pendingBufferMeta.onCopyFn = onCopyFn;
      this.#pendingBufferMeta.onCopyDoneFn = onCopyDoneFn;
      this.#pendingBufferMeta.rejectLength = rejectLength;
    }
    
    resetPendingBufferMeta() {
      this.setPendingBufferMeta({ componentIdx: null, buffer: null, onCopyFn: null, onCopyDoneFn: null, rejectLength: undefined });
    }
    
    getPendingBufferMeta() { return this.#pendingBufferMeta; }
    
    resetAndNotifyPending(result) {
      const f = this.#pendingBufferMeta.onCopyDoneFn;
      this.resetPendingBufferMeta();
      if (f) { f(result); }
    }
    
    cancel() {
      _debugLog('[StreamEnd#cancel()]');
      const completeCancel = () => {
        if (this.isDropped()) { return; }
        // Host injection may complete the copy before this deferred
        // cancellation runs. Preserve that completion event instead of
        // cancelling the next operation or starting a duplicate write.
        if (this.hasPendingEvent()) { return; }
        if (this.#hostCancelFn?.()) { return; }
        const result = this.#pendingBufferMeta?.buffer?.processed > 0
        ? StreamEnd.CopyResult.COMPLETED
        : StreamEnd.CopyResult.CANCELLED;
        this.resetAndNotifyPending(result);
      };
      if (this.#hostInjectFn) {
        setTimeout(completeCancel, 0);
      } else {
        completeCancel();
      }
    }
    
    drop(opts = {}) {
      _debugLog('[StreamEnd#drop()]');
      if (this.isDropped()) { return; }
      const hostDropFn = this.#hostDropFn;
      this.#hostDropFn = null;
      super.drop(opts);
      if (hostDropFn) {
        // A source drop hook can re-enter the component, so both ends must
        // observe the drop before the hook wakes a waiting writer.
        Promise.resolve(hostDropFn()).catch(err => {
          _debugLog('[StreamEnd#drop()] host drop failed', err);
        });
      }
      if (this.#pendingBufferMeta) {
        const result = this.#pendingBufferMeta.buffer?.processed > 0
        ? StreamEnd.CopyResult.COMPLETED
        : StreamEnd.CopyResult.DROPPED;
        this.resetAndNotifyPending(result);
      }
    }
  }
  
  class InternalStream {
    #pendingBufferMeta = {}; // shared between read/write ends
    #elemMeta;
    
    #globalStreamMapRep;
    
    #readEnd;
    #writeEnd;
    
    constructor(args) {
      _debugLog('[InternalStream#constructor()] args', args);
      if (!args.elemMeta) { throw new Error('missing/invalid stream element metadata'); }
      if (args.tableIdx === undefined) { throw new Error('missing/invalid stream table idx'); }
      if (!args.readWaitable) { throw new Error('missing/invalid read waitable'); }
      if (!args.writeWaitable) { throw new Error('missing/invalid write waitable'); }
      const { tableIdx, elemMeta, readWaitable, writeWaitable, } = args;
      
      this.#elemMeta = elemMeta;
      
      let dropped = false;
      const setDroppedFn = () => { dropped = true };
      const isDroppedFn = () => dropped;
      
      this.#readEnd = new StreamReadableEnd({
        tableIdx,
        elemMeta: this.#elemMeta,
        pendingBufferMeta: this.#pendingBufferMeta,
        target: "stream read end (@ init)",
        waitable: readWaitable,
        // Only in-component read-ends need the host inject fn if provided,
        // as that function will *inject* a write when a read is performed
        // from inside the guest.
        hostInjectFn: args.hostInjectFn,
        setDroppedFn,
        isDroppedFn,
      });
      
      this.#writeEnd = new StreamWritableEnd({
        tableIdx,
        elemMeta: this.#elemMeta,
        pendingBufferMeta: this.#pendingBufferMeta,
        target: "stream write end (@ init)",
        waitable: writeWaitable,
        hostOwned: true,
        setDroppedFn,
        isDroppedFn,
      });
    }
    
    elemMeta() { return this.#elemMeta; }
    
    globalStreamMapRep() { return this.#globalStreamMapRep; }
    setGlobalStreamMapRep(rep) {
      this.#globalStreamMapRep = rep;
      this.#readEnd.setGlobalStreamMapRep(rep);
      this.#writeEnd.setGlobalStreamMapRep(rep);
    }
    
    readEnd() { return this.#readEnd; }
    writeEnd() { return this.#writeEnd; }
  }
  
  function createStream(cstate, args) {
    _debugLog('[createStream()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding stream"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding stream"); }
    
    const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
    if (!localStreamTable) {
      throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
    }
    if (componentIdx !== cstate.componentIdx()) {
      throw new Error('component idx mismatch while creating stream');
    }
    
    const readWaitable = cstate.createWaitable();
    const writeWaitable = cstate.createWaitable();
    
    const stream = new InternalStream({
      tableIdx,
      elemMeta,
      readWaitable,
      writeWaitable,
      hostInjectFn,
    });
    stream.setGlobalStreamMapRep(STREAMS.insert(stream));
    
    const writeEnd = stream.writeEnd();
    writeEnd.setWaitableIdx(cstate.handles.insert(writeEnd));
    writeEnd.setHandle(localStreamTable.insert(writeEnd));
    if (writeEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const writeEndWaitableIdx = writeEnd.waitableIdx();
    const writeEndHandle = writeEnd.handle();
    writeWaitable.setTarget(`waitable for stream write end (waitable [${writeEndWaitableIdx}])`);
    writeEnd.setTarget(`stream write end (waitable [${writeEndWaitableIdx}])`);
    
    const readEnd = stream.readEnd();
    readEnd.setWaitableIdx(cstate.handles.insert(readEnd));
    readEnd.setHandle(localStreamTable.insert(readEnd));
    if (readEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const readEndWaitableIdx = readEnd.waitableIdx();
    const readEndHandle = readEnd.handle();
    readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
    readEnd.setTarget(`stream read end (waitable [${readEndWaitableIdx}])`);
    
    return {
      writeEnd,
      writeEndWaitableIdx,
      writeEndHandle,
      readEndWaitableIdx,
      readEndHandle,
      readEnd,
    };
  }
  
  
  const symbolRscRep = Symbol.for('cabiRep');
  const symbolDispose = Symbol.dispose || Symbol.for('dispose');
  const symbolAsyncIterator = Symbol.asyncIterator;
  
  class Stream {
    #globalRep = null;
    #isReadable;
    #isWritable;
    #writeFn;
    #readFn;
    #dropFn;
    
    constructor(args) {
      _debugLog('[Stream#constructor()] args', args);
      
      if (args.globalRep === undefined) { throw new TypeError("missing host stream rep"); }
      this[symbolRscRep] = args.globalRep;
      
      if (args.isReadable === undefined) { throw new TypeError("missing readable setting"); }
      this.#isReadable = args.isReadable;
      
      if (args.isWritable === undefined) { throw new TypeError("missing writable setting"); }
      this.#isWritable = args.isWritable;
      
      if (this.#isWritable && args.writeFn === undefined) { throw new TypeError("missing write fn"); }
      this.#writeFn = args.writeFn;
      
      if (this.#isReadable && args.readFn === undefined) { throw new TypeError("missing read fn"); }
      this.#readFn = args.readFn;
      
      this.#dropFn = args.dropFn;
    }
    
    [symbolAsyncIterator]() { return this; }
    
    async return() {
      this[symbolDispose]();
      return { done: true };
    }
    
    async next() {
      _debugLog('[Stream#next()]');
      return this.read();
    }
    
    async read(opts) {
      _debugLog('[Stream#read()]', { opts });
      if (!this.#isReadable) { throw new Error("stream is not marked as readable and cannot be read from"); }
      const readOpts = this.#readOpts(opts);
      return this.#readFn(readOpts);
    }
    
    #readOpts(opts) {
      const count = opts === undefined ? 1 : typeof opts === "number" ? opts : opts && typeof opts === "object" ? opts.count ?? 1 : undefined;
      const rejectLength = opts && typeof opts === "object" ? opts.rejectLength : undefined;
      if (!Number.isInteger(count) || count < (rejectLength !== undefined ? 0 : 1)) { throw new TypeError(`invalid stream read count [${count}]`); }
      if (rejectLength !== undefined && (!Number.isInteger(rejectLength) || rejectLength < 0)) {
        throw new TypeError(`invalid stream read reject length [${rejectLength}]`);
      }
      return { count, rejectLength };
    }
    
    async write() {
      _debugLog('[Stream#write()]');
      if (!this.#isWritable) { throw new Error("stream is not marked as writable and cannot be written to"); }
      
      const objects = [...arguments];
      if (!objects.length !== 1) {
        throw new Error("only single object writes are currently supported");
      }
      const obj = objects[0];
      
      this.#writeFn(obj);
    }
    
    [symbolDispose]() {
      this.#dropFn?.();
    }
    
  }
  const symbolIterator = Symbol.iterator;
  
  if (!ReadableStream) {
    throw new Error('builtin stream class [ReadableStream] is not available');
  }
  const _PlatformReadableStream= ReadableStream;
  
  
  function _isStreamLowerableObject(obj) {
    if (typeof obj !== 'object') { return false; }
    return obj instanceof Stream
    || symbolAsyncIterator in obj
    || symbolIterator in obj
    || obj instanceof _PlatformReadableStream;
  }
  
  class PendingValueQueue {
    #readFn;
    #elemMeta;
    #done = false;
    #sourceReadPromise = null;
    #chunks = [];
    #offset = 0;
    #length = 0;
    
    constructor(readFn, elemMeta) {
      this.#readFn = readFn;
      this.#elemMeta = elemMeta;
    }
    
    get length() { return this.#length; }
    get done() { return this.#done; }
    get sourceIsSync() { return !!this.#readFn.sourceIsSync; }
    
    push(source) {
      if (source.length === 0) { return 0; }
      this.#chunks.push(source);
      this.#length += source.length;
      return source.length;
    }
    
    appendReadValue(value) {
      if (value === undefined) { return 0; }
      if (this.#elemMeta.isNumeric) {
        if (value instanceof ArrayBuffer) {
          value = new Uint8Array(value);
        }
        if (Array.isArray(value) || (ArrayBuffer.isView(value) && typeof value.length === 'number')) {
          return this.push(value);
        }
      }
      return this.push([value]);
    }
    
    async readSource() {
      if (!this.#sourceReadPromise) {
        this.#sourceReadPromise = (async () => {
          const res = await this.#readFn();
          const appended = this.appendReadValue(res.value);
          this.#done = res.done;
          return appended;
        })().finally(() => {
          this.#sourceReadPromise = null;
        });
      }
      return this.#sourceReadPromise;
    }
    
    prepend(source) {
      if (source.length === 0) { return; }
      if (this.#offset !== 0 && this.#chunks.length > 0) {
        this.#chunks[0] = this.#chunks[0].slice(this.#offset);
        this.#offset = 0;
      }
      this.#chunks.unshift(source);
      this.#length += source.length;
    }
    
    drainInto(target, maxCount) {
      let transferred = 0;
      let remaining = Math.min(maxCount, this.#length);
      while (remaining > 0) {
        const chunk = this.#chunks[0];
        const transfer = Math.min(remaining, chunk.length - this.#offset);
        for (let i = 0; i < transfer; i++) {
          target.push(chunk[this.#offset + i]);
        }
        this.#offset += transfer;
        this.#length -= transfer;
        transferred += transfer;
        remaining -= transfer;
        if (this.#offset === chunk.length) {
          this.#chunks.shift();
          this.#offset = 0;
        }
      }
      return transferred;
    }
  }
  
  function _genStreamHostInjectFn(genArgs) {
    const { readFn, hostWriteEnd, readEnd } = genArgs;
    if (!readEnd) { throw new TypeError('missing read end'); }
    const doNothingFn = () => {};
    const resetWriteEndToIdleFn = () => {
      // After the write is finished, we consume the event that was generated
      // by the just-in-time write (and the subsequent read), if one was generated
      if (hostWriteEnd.hasPendingEvent()) { hostWriteEnd.getPendingEvent(); }
    };
    
    const elemMeta = hostWriteEnd.getElemMeta();
    
    const pendingValues = new PendingValueQueue(readFn, elemMeta);
    
    return async function generatedStreamHostInject(args) {
      let { count } = args;
      if (count < 0) { throw new Error('invalid count'); }
      if (readEnd.hasPendingEvent()) { return resetWriteEndToIdleFn; }
      
      if (hostWriteEnd.isDoneState()) {
        return doNothingFn;
      }
      
      const values = [];
      const hasPendingReadBuffer = () => !!readEnd.getPendingBufferMeta?.().buffer;
      
      const drainPendingValues = () => {
        count -= pendingValues.drainInto(values, count);
      };
      
      const writeValues = async (writeValues) => {
        const writePromise = hostWriteEnd.writeMany(writeValues);
        if (hostWriteEnd.hasPendingEvent()) {
          void writePromise.catch(() => {});
        } else {
          await writePromise;
        }
        resetWriteEndToIdleFn();
      };
      
      const bail = () => {
        pendingValues.prepend(values);
        return doNothingFn;
      };
      
      readEnd.setHostCancelFn?.(() => {
        const buffer = readEnd.getPendingBufferMeta?.().buffer;
        if (!buffer || pendingValues.length === 0) { return false; }
        const cancelValues = [];
        pendingValues.drainInto(cancelValues, buffer.remaining());
        if (cancelValues.length === 0) { return false; }
        const writePromise = hostWriteEnd.writeMany(cancelValues);
        if (!hostWriteEnd.hasPendingEvent()) {
          pendingValues.prepend(cancelValues);
          return false;
        }
        void writePromise.catch(() => {});
        resetWriteEndToIdleFn();
        return true;
      });
      
      if (!hasPendingReadBuffer()) { return doNothingFn; }
      if (count === 0) {
        if (pendingValues.length === 0 && !pendingValues.done) {
          await pendingValues.readSource();
          if (readEnd.hasPendingEvent() || !hasPendingReadBuffer()) { return doNothingFn; }
        }
        if (pendingValues.length > 0) {
          const readyValues = [];
          pendingValues.drainInto(readyValues, 1);
          await writeValues(readyValues);
        } else if (pendingValues.done) {
          hostWriteEnd.getPendingEvent();
          hostWriteEnd.drop();
        }
        return doNothingFn;
      }
      drainPendingValues();
      
      while (count > 0 && !pendingValues.done) {
        const appended = await pendingValues.readSource();
        if (readEnd.hasPendingEvent()) { return bail(); }
        if (!hasPendingReadBuffer()) { return bail(); }
        drainPendingValues();
        // Deliver data as soon as any is available rather than
        // waiting on the source for a full count -- except for
        // synchronous sources, which can be drained eagerly
        // without waiting
        if (values.length > 0 && !pendingValues.sourceIsSync) { break; }
        if (appended === 0 && !pendingValues.done) { count -= 1; }
        if (pendingValues.done) { break; }
      }
      
      // Iterator provided `done: true` with no final value
      if (pendingValues.done && values.length === 0 && pendingValues.length > 0 && hasPendingReadBuffer()) {
        drainPendingValues();
      }
      if (pendingValues.done && values.length === 0) {
        hostWriteEnd.getPendingEvent();
        hostWriteEnd.drop();
        return doNothingFn;
      }
      
      if (!hasPendingReadBuffer()) { return bail(); }
      await writeValues(values);
      
      return doNothingFn;
    };
  }
  
  function _genReadFnFromLowerableStream(stream) {
    if (!_isStreamLowerableObject(stream)) {
      throw new Error("cannot generate read fn: object is not a stream lowerable object");
    }
    
    let readFn;
    if (symbolAsyncIterator in stream) {
      let asyncIterator = stream[symbolAsyncIterator]();
      readFn = () => asyncIterator.next();
      readFn.drop = (reason) => asyncIterator.return?.(reason) ?? stream[symbolDispose]?.();
    } else if (symbolIterator in stream) {
      let iterator = stream[symbolIterator]();
      readFn = async () => iterator.next();
      readFn.drop = (reason) => iterator.return?.(reason) ?? stream[symbolDispose]?.();
      // Synchronous sources can be drained eagerly (up to a
      // requested count) without risking an indefinite wait
      readFn.sourceIsSync = true;
    } else if (stream instanceof _PlatformReadableStream) {
      // At this point we're dealing with a readable stream that *somehow *does not*
      // implement the async iterator protocol.
      const lockedReader = stream.getReader();
      readFn = () => lockedReader.read();
      readFn.drop = (reason) => lockedReader.cancel(reason).finally(() => lockedReader.releaseLock());
    } else {
      throw new Error("invalid stream object, cannot generate read fn");
    }
    
    return readFn;
  }
  
  function _lowerFlatStream(meta) {
    const {
      componentIdx,
      streamTableIdx,
      elemMeta,
    } = meta;
    
    return function _lowerFlatStreamInner(ctx) {
      _debugLog('[_lowerFlatStream()] args', { ctx });
      
      const stream = ctx.vals[0];
      if (!stream) { throw new Error("missing external stream value"); }
      
      let globalRep;
      let waitableIdx;
      if (stream instanceof Stream) {
        globalRep = stream[symbolRscRep];
        const internalStream = STREAMS.get(globalRep);
        if (!internalStream || !(internalStream instanceof InternalStream)) {
          throw new Error(`failed to find internal stream with rep [${globalRep}]`);
        }
        waitableIdx = internalStream.readEnd().waitableIdx();
      } else if (_isStreamLowerableObject(stream)) {
        globalRep = stream[symbolRscRep];
        
        if (globalRep) {
          const hostStream = STREAMS.get(globalRep);
          if (!hostStream) {
            throw new Error(`missing host stream with global rep [${globalRep}]`);
          }
          waitableIdx = hostStream.getStreamEndWaitableIdx();
        } else {
          const cstate = getOrCreateAsyncState(componentIdx);
          if (!cstate) {
            throw new Error(`missing async state for component [${componentIdx}]`);
          }
          
          const { writeEnd, readEnd } = createStream(cstate, {
            tableIdx: streamTableIdx,
            elemMeta,
          });
          
          const readFn = _genReadFnFromLowerableStream(stream);
          const hostInjectFn = _genStreamHostInjectFn({
            readFn,
            hostWriteEnd: writeEnd,
            readEnd,
          });
          readEnd.setHostInjectFn(hostInjectFn);
          readEnd.setHostDropFn(readFn.drop);
          
          waitableIdx = readEnd.waitableIdx();
        }
      } else {
        throw new Error('object does not conform to supported stream interfaces');
      }
      
      // Write the idx of the waitable to memory (a waiting async task or caller)
      if (ctx.storagePtr) {
        ctx.vals[0] = waitableIdx;
        _lowerFlatU32(ctx);
      }
      
      return waitableIdx;
    }
  }
  
  function getStreamEnd(args) {
    _debugLog('[getStreamEnd()] args', args);
    const { tableIdx, streamEndHandle, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) {
      throw new Error('missing table idx while getting stream end');
    }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    let streamEnd;
    if (streamEndWaitableIdx !== undefined) {
      streamEnd = cstate.handles.get(streamEndWaitableIdx);
    } else if (streamEndHandle !== undefined) {
      if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting stream end`); }
      streamEnd = table.get(streamEndHandle);
    } else {
      throw new TypeError("must specify either waitable idx or handle to retrieve stream");
    }
    
    if (!streamEnd) {
      throw new Error(`missing stream end (tableIdx [${tableIdx}], handle [${streamEndHandle}], waitableIdx [${streamEndWaitableIdx}])`);
    }
    if (tableIdx && streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    return streamEnd;
  }
  
  
  function deleteStreamEnd(args) {
    _debugLog('[deleteStreamEnd()] args', args);
    const { tableIdx, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamEndWaitableIdx === undefined) { throw new Error("missing stream idx while removing stream end"); }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const streamEnd = cstate.handles.get(streamEndWaitableIdx);
    if (!streamEnd) {
      throw new Error(`missing stream end [${streamEndWaitableIdx}] in component handles while deleting stream`);
    }
    if (streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    let removed = cstate.handles.remove(streamEnd.waitableIdx());
    if (!removed) {
      throw new Error(`failed to remove stream end [${streamEndWaitableIdx}] waitable obj in component [${componentIdx}]`);
    }
    
    removed = table.remove(streamEnd.handle());
    if (!removed) {
      throw new Error(`failed to remove stream end with handle [${streamEnd.handle()}] from stream table [${tableIdx}] in component [${componentIdx}]`);
    }
    
    return streamEnd;
  }
  
  
  function streamNew(ctx) {
    _debugLog('[streamNew()] args', { ctx });
    const {
      streamTableIdx,
      callerComponentIdx,
      elemMeta,
    } = ctx;
    if (callerComponentIdx === undefined) { throw new Error("missing caller component idx during stream.new"); }
    
    const taskMeta = getCurrentTask(callerComponentIdx);
    if (!taskMeta) { throw new Error('missing async task metadata during stream.new'); }
    
    const task = taskMeta.task
    if (!task) { throw new Error('invalid/missing async task during stream.new'); }
    
    if (task.componentIdx() !== callerComponentIdx) {
      throw new Error(`task component idx [${task.componentIdx()}] does not match stream new intrinsic component idx [${callerComponentIdx}]`);
    }
    
    const cstate = getOrCreateAsyncState(callerComponentIdx);
    if (!cstate.mayLeave) {
      throw new Error('component instance is not marked as may leave during stream.new');
    }
    
    const { writeEndWaitableIdx, readEndWaitableIdx, writeEndHandle, readEndHandle } = createStream(cstate, {
      tableIdx: streamTableIdx,
      elemMeta,
    });
    
    _debugLog('[streamNew()] created stream ends', {
      writeEnd: {
        waitableIdx: writeEndWaitableIdx,
        handle: writeEndHandle,
      },
      readEnd: {
        waitableIdx: readEndWaitableIdx,
        handle: readEndHandle,
      },
      streamTableIdx,
      callerComponentIdx,
    });
    
    return (BigInt(writeEndWaitableIdx) << 32n) | BigInt(readEndWaitableIdx);
  }
  
  async function streamRead(
  ctx,
  streamEndWaitableIdx,
  ptr,
  count,
  ) {
    _debugLog('[streamRead()] args', { ctx, streamEndWaitableIdx, ptr, count });
    const {
      componentIdx,
      memoryIdx,
      getMemoryFn,
      reallocIdx,
      getReallocFn,
      stringEncoding,
      isAsync,
      streamTableIdx,
    } = ctx;
    
    if (componentIdx === undefined) { throw new TypeError("missing/invalid component idx"); }
    if (streamTableIdx === undefined) { throw new TypeError("missing/invalid stream table idx"); }
    if (streamEndWaitableIdx === undefined) { throw new TypeError("missing/invalid stream end idx"); }
    
    // count may come in as u32::MAX which is mangled by JS into a negative value
    count = Math.min(count >>> 0, ManagedBuffer.MAX_LENGTH);
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate.mayLeave) { throw new Error('component instance is not marked as may leave'); }
    
    if (!CURRENT_TASK_MAY_BLOCK && !isAsync) {
      throw new WebAssemblyRuntimeError('only async tasks or otherwise blocking-allowed tasks my stream.streamRead');
    }
    
    const streamEnd = getStreamEnd({ tableIdx: streamTableIdx, streamEndWaitableIdx });
    if (!streamEnd) {
      throw new Error(`missing stream end [${streamEndWaitableIdx}] (table [${streamTableIdx}], component [${componentIdx}])`);
    }
    if (!(streamEnd instanceof StreamReadableEnd)) {
      throw new Error('invalid stream type, expected StreamReadableEnd');
    }
    if (streamEnd.streamTableIdx() !== streamTableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] != operation table idx [${streamTableIdx}]`);
    }
    
    const result = await streamEnd.copy({
      isAsync,
      memory: getMemoryFn?.(),
      ptr,
      count,
      eventCode: ASYNC_EVENT_CODE.STREAM_READ,
      componentIdx,
      stringEncoding,
      realloc: getReallocFn?.(),
      getReallocFn,
    });
    
    return result;
  }
  
  async function streamWrite(
  ctx,
  streamEndWaitableIdx,
  ptr,
  count,
  ) {
    _debugLog('[streamWrite()] args', { ctx, streamEndWaitableIdx, ptr, count });
    const {
      componentIdx,
      memoryIdx,
      getMemoryFn,
      reallocIdx,
      getReallocFn,
      stringEncoding,
      isAsync,
      streamTableIdx,
    } = ctx;
    
    if (componentIdx === undefined) { throw new TypeError("missing/invalid component idx"); }
    if (streamTableIdx === undefined) { throw new TypeError("missing/invalid stream table idx"); }
    if (streamEndWaitableIdx === undefined) { throw new TypeError("missing/invalid stream end idx"); }
    
    // count may come in as u32::MAX which is mangled by JS into a negative value
    count = Math.min(count >>> 0, ManagedBuffer.MAX_LENGTH);
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate.mayLeave) { throw new Error('component instance is not marked as may leave'); }
    
    if (!CURRENT_TASK_MAY_BLOCK && !isAsync) {
      throw new WebAssemblyRuntimeError('only async tasks or otherwise blocking-allowed tasks my stream.streamWrite');
    }
    
    const streamEnd = getStreamEnd({ tableIdx: streamTableIdx, streamEndWaitableIdx });
    if (!streamEnd) {
      throw new Error(`missing stream end [${streamEndWaitableIdx}] (table [${streamTableIdx}], component [${componentIdx}])`);
    }
    if (!(streamEnd instanceof StreamWritableEnd)) {
      throw new Error('invalid stream type, expected StreamWritableEnd');
    }
    if (streamEnd.streamTableIdx() !== streamTableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] != operation table idx [${streamTableIdx}]`);
    }
    
    const result = await streamEnd.copy({
      isAsync,
      memory: getMemoryFn?.(),
      ptr,
      count,
      eventCode: ASYNC_EVENT_CODE.STREAM_WRITE,
      componentIdx,
      stringEncoding,
      realloc: getReallocFn?.(),
      getReallocFn,
    });
    
    return result;
  }
  
  async function streamCancelRead(ctx, streamEndWaitableIdx) {
    _debugLog('[streamCancelRead()] args', { ctx, streamEndWaitableIdx });
    const { streamTableIdx, isAsync, componentIdx } = ctx;
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate.mayLeave) { throw new Error('component instance is not marked as may leave'); }
    
    const streamEnd = getStreamEnd({ streamEndWaitableIdx, tableIdx: streamTableIdx });
    if (!streamEnd) { throw new Error('missing stream end with idx [' + streamEndWaitableIdx + ']'); }
    if (!(streamEnd instanceof StreamReadableEnd)) { throw new Error('invalid stream end, expected value of type [StreamReadableEnd]'); }
    
    if (!streamEnd.isCopying()) { throw new Error('stream end is not copying, cannot cancel'); }
    
    streamEnd.setCopyState(StreamReadableEnd.CopyState.CANCELLING_COPY);
    
    if (!streamEnd.hasPendingEvent()) {
      
      streamEnd.cancel();
      
      if (!streamEnd.hasPendingEvent()) {
        if (isAsync) { return ASYNC_BLOCKED_CODE; }
        
        const taskMeta = getCurrentTask(componentIdx);
        if (!taskMeta) { throw new Error('missing current task metadata while doing stream transfer'); }
        const task = taskMeta.task;
        if (!task) { throw new Error('missing task while doing stream transfer'); }
        await task.suspendUntil({ readyFn: () => streamEnd.hasPendingEvent() });
      }
    }
    
    const event = streamEnd.getPendingEvent();
    const { code, payload0: index, payload1: payload } = event;
    if (streamEnd.isCopying()) {
      throw new Error(`stream end (idx [${streamEndWaitableIdx}]) is still in copying state`);
    }
    if (code !== ASYNC_EVENT_CODE.STREAM_READ) {
      throw new Error(`unexpected event code [${code}], expected [ASYNC_EVENT_CODE.STREAM_READ]`);
    }
    if (index !== streamEnd.waitableIdx()) { throw new Error('event index does not match stream end'); }
    
    _debugLog('[streamCancelRead()] successful cancel', { ctx, streamEndWaitableIdx, streamEnd, event });
    return payload;
  }
  
  async function streamCancelWrite(ctx, streamEndWaitableIdx) {
    _debugLog('[streamCancelWrite()] args', { ctx, streamEndWaitableIdx });
    const { streamTableIdx, isAsync, componentIdx } = ctx;
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate.mayLeave) { throw new Error('component instance is not marked as may leave'); }
    
    const streamEnd = getStreamEnd({ streamEndWaitableIdx, tableIdx: streamTableIdx });
    if (!streamEnd) { throw new Error('missing stream end with idx [' + streamEndWaitableIdx + ']'); }
    if (!(streamEnd instanceof StreamWritableEnd)) { throw new Error('invalid stream end, expected value of type [StreamWritableEnd]'); }
    
    if (!streamEnd.isCopying()) { throw new Error('stream end is not copying, cannot cancel'); }
    
    streamEnd.setCopyState(StreamWritableEnd.CopyState.CANCELLING_COPY);
    
    if (!streamEnd.hasPendingEvent()) {
      
      streamEnd.cancel();
      
      if (!streamEnd.hasPendingEvent()) {
        if (isAsync) { return ASYNC_BLOCKED_CODE; }
        
        const taskMeta = getCurrentTask(componentIdx);
        if (!taskMeta) { throw new Error('missing current task metadata while doing stream transfer'); }
        const task = taskMeta.task;
        if (!task) { throw new Error('missing task while doing stream transfer'); }
        await task.suspendUntil({ readyFn: () => streamEnd.hasPendingEvent() });
      }
    }
    
    const event = streamEnd.getPendingEvent();
    const { code, payload0: index, payload1: payload } = event;
    if (streamEnd.isCopying()) {
      throw new Error(`stream end (idx [${streamEndWaitableIdx}]) is still in copying state`);
    }
    if (code !== ASYNC_EVENT_CODE.STREAM_WRITE) {
      throw new Error(`unexpected event code [${code}], expected [ASYNC_EVENT_CODE.STREAM_WRITE]`);
    }
    if (index !== streamEnd.waitableIdx()) { throw new Error('event index does not match stream end'); }
    
    _debugLog('[streamCancelWrite()] successful cancel', { ctx, streamEndWaitableIdx, streamEnd, event });
    return payload;
  }
  
  function streamDropReadable(ctx, streamEndWaitableIdx) {
    _debugLog('[streamDropReadable()] args', { ctx, streamEndWaitableIdx });
    const { streamTableIdx, componentIdx } = ctx;
    
    const task = getCurrentTask(componentIdx);
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate) { throw new Error(`missing component state for component idx [${componentIdx}]`); }
    
    const streamEnd = deleteStreamEnd({ tableIdx: streamTableIdx, streamEndWaitableIdx });
    if (!streamEnd) {
      throw new Error(`missing stream (waitable [${streamEndWaitableIdx}], table [${streamTableIdx}], component [${componentIdx}])`);
    }
    
    if (!(streamEnd instanceof StreamReadableEnd)) {
      throw new Error('invalid stream end class, expected [StreamReadableEnd]');
    }
    
    streamEnd.drop();
  }
  
  function streamDropWritable(ctx, streamEndWaitableIdx) {
    _debugLog('[streamDropWritable()] args', { ctx, streamEndWaitableIdx });
    const { streamTableIdx, componentIdx } = ctx;
    
    const task = getCurrentTask(componentIdx);
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    if (!cstate) { throw new Error(`missing component state for component idx [${componentIdx}]`); }
    
    const streamEnd = deleteStreamEnd({ tableIdx: streamTableIdx, streamEndWaitableIdx });
    if (!streamEnd) {
      throw new Error(`missing stream (waitable [${streamEndWaitableIdx}], table [${streamTableIdx}], component [${componentIdx}])`);
    }
    
    if (!(streamEnd instanceof StreamWritableEnd)) {
      throw new Error('invalid stream end class, expected [StreamWritableEnd]');
    }
    
    streamEnd.drop();
  }
  
  function _guardMayLeave(componentIdx, fn) {
    return function (...args) {
      _checkMayLeave(componentIdx);
      return fn.apply(this, args);
    };
  }
  
  const base64Compile = str => WebAssembly.compile(Uint8Array.from(atob(str), b => b.charCodeAt(0)));
  
  
  const fetchCompile = url => fetch(url).then(WebAssembly.compileStreaming);
  
  const symbolCabiDispose = Symbol.for('cabiDispose');
  
  const symbolRscHandle = Symbol('handle');
  
  const HANDLE_TABLES= [];
  
  
  class ComponentError extends Error {
    constructor (value) {
      const enumerable = typeof value !== 'string';
      super(enumerable ? `${String(value)} (see error.payload)` : value);
      Object.defineProperty(this, 'payload', { value, enumerable });
    }
  }
  
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  
  function getErrorPayload(e) {
    if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
    if (e instanceof Error) throw e;
    return e;
  }
  
  function throwInvalidBool() {
    throw new TypeError('invalid variant discriminant for bool');
  }
  
  const instantiateCore = WebAssembly.instantiate;
  
  function registerGlobalMemoryForComponent(args) {
    const { componentIdx, memory, memoryIdx } = args ?? {};
    if (componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (memory === undefined && memoryIdx === undefined) { throw new TypeError('missing both memory & memory idx'); }
    let inner = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!inner) {
      inner = {};
      GLOBAL_COMPONENT_MEMORY_MAP.set(componentIdx, inner);
    }
    
    inner[memoryIdx] = { memory, memoryIdx, componentIdx };
  }
  
  function _suspendingImport(componentIdx, fn) {
    return async function (...args) {
      _checkMayLeave(componentIdx);
      const saved = CURRENT_TASK_META[componentIdx] ?? null;
      try {
        return await fn.apply(null, args);
      } finally {
        CURRENT_TASK_META[componentIdx] = saved;
      }
    };
  }
  
  
  STREAM_TABLES[0] = { componentIdx: 0, table: new RepTable() };
  STREAM_TABLES[1] = { componentIdx: 0, table: new RepTable() };
  STREAM_TABLES[2] = { componentIdx: 0, table: new RepTable() };
  STREAM_TABLES[3] = { componentIdx: 0, table: new RepTable() };
  let exports0;
  
  const handleTable0 = [T_FLAG, 0];
  handleTable0._createdReps = new Set();
  
  
  const captureTable0= new Map();
  let captureCnt0= 0;
  
  HANDLE_TABLES[0] = handleTable0;
  
  const _trampoline0 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable0.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Gpu.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu.get-preferred-canvas-format"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getPreferredCanvasFormat',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.getPreferredCanvasFormat(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var val3 = ret;
    let enum3;
    switch (val3) {
      case 'r8unorm': {
        enum3 = 0;
        break;
      }
      case 'r8snorm': {
        enum3 = 1;
        break;
      }
      case 'r8uint': {
        enum3 = 2;
        break;
      }
      case 'r8sint': {
        enum3 = 3;
        break;
      }
      case 'r16unorm': {
        enum3 = 4;
        break;
      }
      case 'r16snorm': {
        enum3 = 5;
        break;
      }
      case 'r16uint': {
        enum3 = 6;
        break;
      }
      case 'r16sint': {
        enum3 = 7;
        break;
      }
      case 'r16float': {
        enum3 = 8;
        break;
      }
      case 'rg8unorm': {
        enum3 = 9;
        break;
      }
      case 'rg8snorm': {
        enum3 = 10;
        break;
      }
      case 'rg8uint': {
        enum3 = 11;
        break;
      }
      case 'rg8sint': {
        enum3 = 12;
        break;
      }
      case 'r32uint': {
        enum3 = 13;
        break;
      }
      case 'r32sint': {
        enum3 = 14;
        break;
      }
      case 'r32float': {
        enum3 = 15;
        break;
      }
      case 'rg16unorm': {
        enum3 = 16;
        break;
      }
      case 'rg16snorm': {
        enum3 = 17;
        break;
      }
      case 'rg16uint': {
        enum3 = 18;
        break;
      }
      case 'rg16sint': {
        enum3 = 19;
        break;
      }
      case 'rg16float': {
        enum3 = 20;
        break;
      }
      case 'rgba8unorm': {
        enum3 = 21;
        break;
      }
      case 'rgba8unorm-srgb': {
        enum3 = 22;
        break;
      }
      case 'rgba8snorm': {
        enum3 = 23;
        break;
      }
      case 'rgba8uint': {
        enum3 = 24;
        break;
      }
      case 'rgba8sint': {
        enum3 = 25;
        break;
      }
      case 'bgra8unorm': {
        enum3 = 26;
        break;
      }
      case 'bgra8unorm-srgb': {
        enum3 = 27;
        break;
      }
      case 'rgb9e5ufloat': {
        enum3 = 28;
        break;
      }
      case 'rgb10a2uint': {
        enum3 = 29;
        break;
      }
      case 'rgb10a2unorm': {
        enum3 = 30;
        break;
      }
      case 'rg11b10ufloat': {
        enum3 = 31;
        break;
      }
      case 'rg32uint': {
        enum3 = 32;
        break;
      }
      case 'rg32sint': {
        enum3 = 33;
        break;
      }
      case 'rg32float': {
        enum3 = 34;
        break;
      }
      case 'rgba16unorm': {
        enum3 = 35;
        break;
      }
      case 'rgba16snorm': {
        enum3 = 36;
        break;
      }
      case 'rgba16uint': {
        enum3 = 37;
        break;
      }
      case 'rgba16sint': {
        enum3 = 38;
        break;
      }
      case 'rgba16float': {
        enum3 = 39;
        break;
      }
      case 'rgba32uint': {
        enum3 = 40;
        break;
      }
      case 'rgba32sint': {
        enum3 = 41;
        break;
      }
      case 'rgba32float': {
        enum3 = 42;
        break;
      }
      case 'stencil8': {
        enum3 = 43;
        break;
      }
      case 'depth16unorm': {
        enum3 = 44;
        break;
      }
      case 'depth24plus': {
        enum3 = 45;
        break;
      }
      case 'depth24plus-stencil8': {
        enum3 = 46;
        break;
      }
      case 'depth32float': {
        enum3 = 47;
        break;
      }
      case 'depth32float-stencil8': {
        enum3 = 48;
        break;
      }
      case 'bc1-rgba-unorm': {
        enum3 = 49;
        break;
      }
      case 'bc1-rgba-unorm-srgb': {
        enum3 = 50;
        break;
      }
      case 'bc2-rgba-unorm': {
        enum3 = 51;
        break;
      }
      case 'bc2-rgba-unorm-srgb': {
        enum3 = 52;
        break;
      }
      case 'bc3-rgba-unorm': {
        enum3 = 53;
        break;
      }
      case 'bc3-rgba-unorm-srgb': {
        enum3 = 54;
        break;
      }
      case 'bc4-r-unorm': {
        enum3 = 55;
        break;
      }
      case 'bc4-r-snorm': {
        enum3 = 56;
        break;
      }
      case 'bc5-rg-unorm': {
        enum3 = 57;
        break;
      }
      case 'bc5-rg-snorm': {
        enum3 = 58;
        break;
      }
      case 'bc6h-rgb-ufloat': {
        enum3 = 59;
        break;
      }
      case 'bc6h-rgb-float': {
        enum3 = 60;
        break;
      }
      case 'bc7-rgba-unorm': {
        enum3 = 61;
        break;
      }
      case 'bc7-rgba-unorm-srgb': {
        enum3 = 62;
        break;
      }
      case 'etc2-rgb8unorm': {
        enum3 = 63;
        break;
      }
      case 'etc2-rgb8unorm-srgb': {
        enum3 = 64;
        break;
      }
      case 'etc2-rgb8a1unorm': {
        enum3 = 65;
        break;
      }
      case 'etc2-rgb8a1unorm-srgb': {
        enum3 = 66;
        break;
      }
      case 'etc2-rgba8unorm': {
        enum3 = 67;
        break;
      }
      case 'etc2-rgba8unorm-srgb': {
        enum3 = 68;
        break;
      }
      case 'eac-r11unorm': {
        enum3 = 69;
        break;
      }
      case 'eac-r11snorm': {
        enum3 = 70;
        break;
      }
      case 'eac-rg11unorm': {
        enum3 = 71;
        break;
      }
      case 'eac-rg11snorm': {
        enum3 = 72;
        break;
      }
      case 'astc4x4-unorm': {
        enum3 = 73;
        break;
      }
      case 'astc4x4-unorm-srgb': {
        enum3 = 74;
        break;
      }
      case 'astc5x4-unorm': {
        enum3 = 75;
        break;
      }
      case 'astc5x4-unorm-srgb': {
        enum3 = 76;
        break;
      }
      case 'astc5x5-unorm': {
        enum3 = 77;
        break;
      }
      case 'astc5x5-unorm-srgb': {
        enum3 = 78;
        break;
      }
      case 'astc6x5-unorm': {
        enum3 = 79;
        break;
      }
      case 'astc6x5-unorm-srgb': {
        enum3 = 80;
        break;
      }
      case 'astc6x6-unorm': {
        enum3 = 81;
        break;
      }
      case 'astc6x6-unorm-srgb': {
        enum3 = 82;
        break;
      }
      case 'astc8x5-unorm': {
        enum3 = 83;
        break;
      }
      case 'astc8x5-unorm-srgb': {
        enum3 = 84;
        break;
      }
      case 'astc8x6-unorm': {
        enum3 = 85;
        break;
      }
      case 'astc8x6-unorm-srgb': {
        enum3 = 86;
        break;
      }
      case 'astc8x8-unorm': {
        enum3 = 87;
        break;
      }
      case 'astc8x8-unorm-srgb': {
        enum3 = 88;
        break;
      }
      case 'astc10x5-unorm': {
        enum3 = 89;
        break;
      }
      case 'astc10x5-unorm-srgb': {
        enum3 = 90;
        break;
      }
      case 'astc10x6-unorm': {
        enum3 = 91;
        break;
      }
      case 'astc10x6-unorm-srgb': {
        enum3 = 92;
        break;
      }
      case 'astc10x8-unorm': {
        enum3 = 93;
        break;
      }
      case 'astc10x8-unorm-srgb': {
        enum3 = 94;
        break;
      }
      case 'astc10x10-unorm': {
        enum3 = 95;
        break;
      }
      case 'astc10x10-unorm-srgb': {
        enum3 = 96;
        break;
      }
      case 'astc12x10-unorm': {
        enum3 = 97;
        break;
      }
      case 'astc12x10-unorm-srgb': {
        enum3 = 98;
        break;
      }
      case 'astc12x12-unorm': {
        enum3 = 99;
        break;
      }
      case 'astc12x12-unorm-srgb': {
        enum3 = 100;
        break;
      }
      default: {
        if ((ret) instanceof Error) {
          console.error(ret);
        }
        
        throw new TypeError(`"${val3}" is not one of the cases of gpu-texture-format`);
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu.get-preferred-canvas-format"][Instruction::Return]', {
      funcName: '[method]gpu.get-preferred-canvas-format',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([enum3]);
    task.exit();
    return enum3;
  }
  _trampoline0.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#getPreferredCanvasFormat';
  
  const handleTable3 = [T_FLAG, 0];
  handleTable3._createdReps = new Set();
  
  
  const captureTable3= new Map();
  let captureCnt3= 0;
  
  HANDLE_TABLES[3] = handleTable3;
  
  const handleTable9 = [T_FLAG, 0];
  handleTable9._createdReps = new Set();
  
  
  const captureTable9= new Map();
  let captureCnt9= 0;
  
  HANDLE_TABLES[9] = handleTable9;
  
  const _trampoline2 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.queue"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'queue',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.queue(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuQueue)) {
      throw new TypeError('Resource error: Not a valid \"GpuQueue\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt9;
      captureTable9.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable9, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.queue"][Instruction::Return]', {
      funcName: '[method]gpu-device.queue',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline2.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#queue';
  
  const handleTable7 = [T_FLAG, 0];
  handleTable7._createdReps = new Set();
  
  
  const captureTable7= new Map();
  let captureCnt7= 0;
  
  HANDLE_TABLES[7] = handleTable7;
  
  const _trampoline4 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable7.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuRenderPassEncoder.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.end"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'end',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.end(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.end"][Instruction::Return]', {
      funcName: '[method]gpu-render-pass-encoder.end',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline4.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#end';
  
  const handleTable14 = [T_FLAG, 0];
  handleTable14._createdReps = new Set();
  
  
  const captureTable14= new Map();
  let captureCnt14= 0;
  
  HANDLE_TABLES[14] = handleTable14;
  
  const _trampoline5 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable7.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuRenderPassEncoder.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var handle4 = arg1;
    
    var rep5 = handleTable14[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable14.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(GpuRenderPipeline.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    
    curResourceBorrows.push(rsc3);
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.set-pipeline"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'setPipeline',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.setPipeline(rsc3),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.set-pipeline"][Instruction::Return]', {
      funcName: '[method]gpu-render-pass-encoder.set-pipeline',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline5.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#setPipeline';
  
  const _trampoline6 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    var handle1 = arg0;
    
    var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable7.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuRenderPassEncoder.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant3;
    switch (arg2) {
      case 0: {
        variant3 = undefined;
        break;
      }
      case 1: {
        variant3 = arg3 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant4;
    switch (arg4) {
      case 0: {
        variant4 = undefined;
        break;
      }
      case 1: {
        variant4 = arg5 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant5;
    switch (arg6) {
      case 0: {
        variant5 = undefined;
        break;
      }
      case 1: {
        variant5 = arg7 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.draw"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'draw',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.draw(arg1 >>> 0, variant3, variant4, variant5),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-render-pass-encoder.draw"][Instruction::Return]', {
      funcName: '[method]gpu-render-pass-encoder.draw',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline6.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#draw';
  
  const _trampoline7 = function() {
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="get-gpu"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getGpu',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getGpu(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof Gpu)) {
      throw new TypeError('Resource error: Not a valid \"Gpu\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt0;
      captureTable0.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable0, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="get-gpu"][Instruction::Return]', {
      funcName: 'get-gpu',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline7.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#getGpu';
  
  const handleTable16 = [T_FLAG, 0];
  handleTable16._createdReps = new Set();
  
  
  const captureTable16= new Map();
  let captureCnt16= 0;
  
  HANDLE_TABLES[16] = handleTable16;
  
  const _trampoline8 = function(arg0, arg1, arg2, arg3) {
    let variant0;
    switch (arg0) {
      case 0: {
        variant0 = undefined;
        break;
      }
      case 1: {
        variant0 = arg1 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant1;
    switch (arg2) {
      case 0: {
        variant1 = undefined;
        break;
      }
      case 1: {
        variant1 = arg3 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[constructor]surface"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'new Surface',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => new Surface({
          height: variant0,
          width: variant1,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof Surface)) {
      throw new TypeError('Resource error: Not a valid \"Surface\" resource.');
    }
    var handle2 = ret[symbolRscHandle];
    if (!handle2) {
      const rep = ret[symbolRscRep] || ++captureCnt16;
      captureTable16.set(rep, ret);
      handle2 = rscTableCreateOwn(handleTable16, rep);
    }
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[constructor]surface"][Instruction::Return]', {
      funcName: '[constructor]surface',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle2]);
    task.exit();
    return handle2;
  }
  _trampoline8.fnName = 'wasi-gfx:surface/surface@0.2.0#new Surface';
  
  const _trampoline9 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-resize"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onResize',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onResize(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['height', _liftFlatU32, 4, 4],['width', _liftFlatU32, 4, 4],], size32: 8, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['height', _lowerFlatU32, 4, 4 ],['width', _lowerFlatU32, 4, 4 ],], size32: 8, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(27))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 2,
        align32: 4,
        size32: 8,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-resize"][Instruction::Return]', {
      funcName: '[method]surface.on-resize',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline9.fnName = 'wasi-gfx:surface/surface@0.2.0#onResize';
  
  const _trampoline10 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-frame"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onFrame',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onFrame(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 1,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['nothing', _liftFlatBool, 1, 1],], size32: 1, align32: 1 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['nothing', _lowerFlatBool, 1, 1 ],], size32: 1, align32: 1 }),
        payloadTypeName: 'Record(TypeRecordIndex(28))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 1,
        align32: 1,
        size32: 1,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-frame"][Instruction::Return]', {
      funcName: '[method]surface.on-frame',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline10.fnName = 'wasi-gfx:surface/surface@0.2.0#onFrame';
  
  const _trampoline11 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-up"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onPointerUp',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onPointerUp(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 2,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 2,
        align32: 8,
        size32: 16,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-up"][Instruction::Return]', {
      funcName: '[method]surface.on-pointer-up',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline11.fnName = 'wasi-gfx:surface/surface@0.2.0#onPointerUp';
  
  const _trampoline12 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-down"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onPointerDown',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onPointerDown(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 2,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 2,
        align32: 8,
        size32: 16,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-down"][Instruction::Return]', {
      funcName: '[method]surface.on-pointer-down',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline12.fnName = 'wasi-gfx:surface/surface@0.2.0#onPointerDown';
  
  const _trampoline13 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-move"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onPointerMove',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onPointerMove(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 2,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 2,
        align32: 8,
        size32: 16,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-pointer-move"][Instruction::Return]', {
      funcName: '[method]surface.on-pointer-move',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline13.fnName = 'wasi-gfx:surface/surface@0.2.0#onPointerMove';
  
  const _trampoline14 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-key-up"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onKeyUp',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onKeyUp(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 3,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 9,
        align32: 4,
        size32: 20,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-key-up"][Instruction::Return]', {
      funcName: '[method]surface.on-key-up',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline14.fnName = 'wasi-gfx:surface/surface@0.2.0#onKeyUp';
  
  const _trampoline15 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-key-down"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'onKeyDown',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.onKeyDown(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(symbolAsyncIterator in ret)
    && !(symbolIterator in ret)
    && !(ret instanceof _PlatformReadableStream)) {
      _debugLog('[Instruction::StreamLower] object with no supported stream protocol', { ret});
      throw new Error('unrecognized stream object (no supported stream protocol)');
    }
    
    const cstate3 = getOrCreateAsyncState(0);
    if (!cstate3) { throw new Error(`missing component state for component [0]`); }
    
    const { writeEnd: hostWriteEnd3, readEnd: readEnd3 } = createStream(cstate3, {
      tableIdx: 3,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        flatCount: 9,
        align32: 4,
        size32: 20,
        // TODO(feat): facilitate non utf8 string encoding for lowered streams
        stringEncoding: 'utf8',
        getReallocFn: undefined,
      },
    });
    
    const readFn3 = _genReadFnFromLowerableStream(ret);
    
    const hostInjectFn = _genStreamHostInjectFn({
      readFn: readFn3,
      hostWriteEnd: hostWriteEnd3,
      readEnd: readEnd3,
    });
    readEnd3.setHostInjectFn(hostInjectFn);
    readEnd3.setHostDropFn(readFn3.drop);
    
    const streamWaitableIdx3 = readEnd3.waitableIdx();
    
    _debugLog('[iface="wasi-gfx:surface/surface@0.2.0", function="[method]surface.on-key-down"][Instruction::Return]', {
      funcName: '[method]surface.on-key-down',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([streamWaitableIdx3]);
    task.exit();
    return streamWaitableIdx3;
  }
  _trampoline15.fnName = 'wasi-gfx:surface/surface@0.2.0#onKeyDown';
  
  const handleTable17 = [T_FLAG, 0];
  handleTable17._createdReps = new Set();
  
  
  const captureTable17= new Map();
  let captureCnt17= 0;
  
  HANDLE_TABLES[17] = handleTable17;
  
  const _trampoline16 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable16[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable16.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Surface.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[constructor]context"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'new Context',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => new Context(rsc0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof Context)) {
      throw new TypeError('Resource error: Not a valid \"Context\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt17;
      captureTable17.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable17, rep);
    }
    
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[constructor]context"][Instruction::Return]', {
      funcName: '[constructor]context',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline16.fnName = 'wasi-gfx:surface/surface-webgpu@0.2.0#new Context';
  
  const handleTable15 = [T_FLAG, 0];
  handleTable15._createdReps = new Set();
  
  
  const captureTable15= new Map();
  let captureCnt15= 0;
  
  HANDLE_TABLES[15] = handleTable15;
  
  const _trampoline17 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable17.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Context.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.get-current-texture"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getCurrentTexture',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.getCurrentTexture(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuTexture)) {
      throw new TypeError('Resource error: Not a valid \"GpuTexture\" resource.');
    }
    var handle3 = ret[symbolRscHandle];
    if (!handle3) {
      const rep = ret[symbolRscRep] || ++captureCnt15;
      captureTable15.set(rep, ret);
      handle3 = rscTableCreateOwn(handleTable15, rep);
    }
    
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.get-current-texture"][Instruction::Return]', {
      funcName: '[method]context.get-current-texture',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle3]);
    task.exit();
    return handle3;
  }
  _trampoline17.fnName = 'wasi-gfx:surface/surface-webgpu@0.2.0#getCurrentTexture';
  
  const _trampoline18 = function(arg0) {
    var handle1 = arg0;
    
    var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable17.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Context.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.present"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'present',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.present(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.present"][Instruction::Return]', {
      funcName: '[method]context.present',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline18.fnName = 'wasi-gfx:surface/surface-webgpu@0.2.0#present';
  let exports1;
  let memory0;
  let realloc0;
  let realloc0Async;
  
  const handleTable1 = [T_FLAG, 0];
  handleTable1._createdReps = new Set();
  
  
  const captureTable1= new Map();
  let captureCnt1= 0;
  
  HANDLE_TABLES[1] = handleTable1;
  
  const _trampoline60 = async function(arg0, arg1) {
    var handle1 = dataView(memory0).getInt32(arg0 + 0, true);
    
    var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable0.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Gpu.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant11;
    switch (dataView(memory0).getUint8(arg0 + 4, true)) {
      case 0: {
        variant11 = undefined;
        break;
      }
      case 1: {
        let variant4;
        switch (dataView(memory0).getUint8(arg0 + 8, true)) {
          case 0: {
            variant4 = undefined;
            break;
          }
          case 1: {
            var ptr3 = dataView(memory0).getUint32(arg0 + 12, true);
            var len3 = dataView(memory0).getUint32(arg0 + 16, true);
            var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
            variant4 = result3;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant6;
        switch (dataView(memory0).getUint8(arg0 + 20, true)) {
          case 0: {
            variant6 = undefined;
            break;
          }
          case 1: {
            let enum5;
            switch (dataView(memory0).getUint8(arg0 + 21, true)) {
              case 0: {
                enum5 = 'low-power';
                break;
              }
              case 1: {
                enum5 = 'high-performance';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuPowerPreference');
              }
            }
            variant6 = enum5;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant8;
        switch (dataView(memory0).getUint8(arg0 + 22, true)) {
          case 0: {
            variant8 = undefined;
            break;
          }
          case 1: {
            var bool7 = dataView(memory0).getUint8(arg0 + 23, true);
            variant8 = bool7 == 0 ? false : (bool7 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant10;
        switch (dataView(memory0).getUint8(arg0 + 24, true)) {
          case 0: {
            variant10 = undefined;
            break;
          }
          case 1: {
            var bool9 = dataView(memory0).getUint8(arg0 + 25, true);
            variant10 = bool9 == 0 ? false : (bool9 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant11 = {
          featureLevel: variant4,
          powerPreference: variant6,
          forceFallbackAdapter: variant8,
          xrCompatible: variant10,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu.request-adapter"] [Instruction::CallInterface] (async, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: true,
        entryFnName: 'requestAdapter',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    
    const started = await task.enter({ isHost: hostProvided });
    if (!started) {
      _debugLog('[Instruction::CallInterface] failed to enter task', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
      });
      throw new Error("failed to enter task");
    }
    
    
    let ret;
    
    try {
      ret = await  _withGlobalCurrentTaskMetaAsync({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.requestAdapter(variant11),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during async call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      return task.completionPromise();
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant13 = ret;
    let variant13_0;
    let variant13_1;
    if (variant13 === null || variant13=== undefined) {
      variant13_0 = 0;
      variant13_1 = 0;
    } else {
      const e = variant13;
      
      if (!(e instanceof GpuAdapter)) {
        throw new TypeError('Resource error: Not a valid \"GpuAdapter\" resource.');
      }
      var handle12 = e[symbolRscHandle];
      if (!handle12) {
        const rep = e[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep, e);
        handle12 = rscTableCreateOwn(handleTable1, rep);
      }
      
      variant13_0 = 1;
      variant13_1 = handle12;
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu.request-adapter"][Instruction::AsyncTaskReturn]', {
      funcName: '[task-return][method]gpu.request-adapter',
      paramCount: 2,
      componentIdx: 0,
      postReturn: false,
      hostProvided,
    });
    
    if (hostProvided) {
      _debugLog('[Instruction::AsyncTaskReturn] signaling host-provided async return completion', {
        task: task.id(),
        subtask: subtask?.id(),
        result: ret,
      })
      task.resolve([ret]);
      task.exit();
      return ret;
    }
    
    const componentState = getOrCreateAsyncState(0);
    if (!componentState) { throw new Error('failed to lookup current component state'); }
    
    queueMicrotask(async (resolve, reject) => {
      try {
        _debugLog("[Instruction::AsyncTaskReturn] starting driver loop", {
          fnName: '[task-return][method]gpu.request-adapter',
          componentInstanceIdx: 0,
          taskID: task.id(),
        });
        await _driverLoop({
          componentInstanceIdx: 0,
          componentState,
          task,
          fnName: '[task-return][method]gpu.request-adapter',
          isAsync: true,
          callbackResult: ret,
        });
      } catch (err) {
        _debugLog("[Instruction::AsyncTaskReturn] driver loop call failure", { err });
      }
    });
    
    let taskRes = await task.completionPromise();
    if (task.getErrHandling() === 'throw-result-err') {
      if (typeof taskRes !== 'object') {
        return taskRes;
      }
      if (taskRes.tag === 'err') { throw new ComponentError(taskRes.val);}
      if (taskRes.tag === 'ok') { taskRes = taskRes.val; }
    }
    
    return taskRes;
    
  }
  _trampoline60.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#requestAdapter';
  
  const handleTable2 = [T_FLAG, 0];
  handleTable2._createdReps = new Set();
  
  
  const captureTable2= new Map();
  let captureCnt2= 0;
  
  HANDLE_TABLES[2] = handleTable2;
  
  const _trampoline61 = async function(arg0, arg1) {
    var handle1 = dataView(memory0).getInt32(arg0 + 0, true);
    
    var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable1.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuAdapter.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant15;
    switch (dataView(memory0).getUint8(arg0 + 4, true)) {
      case 0: {
        variant15 = undefined;
        break;
      }
      case 1: {
        let variant5;
        switch (dataView(memory0).getUint8(arg0 + 8, true)) {
          case 0: {
            variant5 = undefined;
            break;
          }
          case 1: {
            var len4 = dataView(memory0).getUint32(arg0 + 16, true);
            var base4 = dataView(memory0).getUint32(arg0 + 12, true);
            if (base4 % 1 !== 0) throw new TypeError(`list pointer [${base4}] is not aligned to 1`);
            var result4 = [];
            for (let i = 0; i < len4; i++) {
              const base = base4 + i * 1;
              let enum3;
              switch (dataView(memory0).getUint8(base + 0, true)) {
                case 0: {
                  enum3 = 'core-features-and-limits';
                  break;
                }
                case 1: {
                  enum3 = 'depth-clip-control';
                  break;
                }
                case 2: {
                  enum3 = 'depth32float-stencil8';
                  break;
                }
                case 3: {
                  enum3 = 'texture-compression-bc';
                  break;
                }
                case 4: {
                  enum3 = 'texture-compression-bc-sliced3d';
                  break;
                }
                case 5: {
                  enum3 = 'texture-compression-etc2';
                  break;
                }
                case 6: {
                  enum3 = 'texture-compression-astc';
                  break;
                }
                case 7: {
                  enum3 = 'texture-compression-astc-sliced3d';
                  break;
                }
                case 8: {
                  enum3 = 'timestamp-query';
                  break;
                }
                case 9: {
                  enum3 = 'indirect-first-instance';
                  break;
                }
                case 10: {
                  enum3 = 'shader-f16';
                  break;
                }
                case 11: {
                  enum3 = 'rg11b10ufloat-renderable';
                  break;
                }
                case 12: {
                  enum3 = 'bgra8unorm-storage';
                  break;
                }
                case 13: {
                  enum3 = 'float32-filterable';
                  break;
                }
                case 14: {
                  enum3 = 'float32-blendable';
                  break;
                }
                case 15: {
                  enum3 = 'clip-distances';
                  break;
                }
                case 16: {
                  enum3 = 'dual-source-blending';
                  break;
                }
                case 17: {
                  enum3 = 'subgroups';
                  break;
                }
                case 18: {
                  enum3 = 'texture-formats-tier1';
                  break;
                }
                case 19: {
                  enum3 = 'texture-formats-tier2';
                  break;
                }
                case 20: {
                  enum3 = 'primitive-index';
                  break;
                }
                case 21: {
                  enum3 = 'texture-component-swizzle';
                  break;
                }
                default: {
                  throw new TypeError('invalid discriminant specified for GpuFeatureName');
                }
              }
              result4.push(enum3);
            }
            variant5 = result4;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant9;
        switch (dataView(memory0).getUint8(arg0 + 20, true)) {
          case 0: {
            variant9 = undefined;
            break;
          }
          case 1: {
            var handle7 = dataView(memory0).getInt32(arg0 + 24, true);
            
            var rep8 = handleTable2[(handle7 << 1) + 1] & ~T_FLAG;
            var rsc6 = captureTable2.get(rep8);
            if (!rsc6) {
              rsc6 = Object.create(RecordOptionGpuSize64.prototype);
              Object.defineProperty(rsc6, symbolRscHandle, { writable: true, value: handle7});
              Object.defineProperty(rsc6, symbolRscRep, { writable: true, value: rep8});
            }
            
            else {
              captureTable2.delete(rep8);
            }
            rscTableRemove(handleTable2, handle7);
            variant9 = rsc6;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant12;
        switch (dataView(memory0).getUint8(arg0 + 28, true)) {
          case 0: {
            variant12 = undefined;
            break;
          }
          case 1: {
            let variant11;
            switch (dataView(memory0).getUint8(arg0 + 32, true)) {
              case 0: {
                variant11 = undefined;
                break;
              }
              case 1: {
                var ptr10 = dataView(memory0).getUint32(arg0 + 36, true);
                var len10 = dataView(memory0).getUint32(arg0 + 40, true);
                var result10 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr10, len10));
                variant11 = result10;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            variant12 = {
              label: variant11,
            };
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant14;
        switch (dataView(memory0).getUint8(arg0 + 44, true)) {
          case 0: {
            variant14 = undefined;
            break;
          }
          case 1: {
            var ptr13 = dataView(memory0).getUint32(arg0 + 48, true);
            var len13 = dataView(memory0).getUint32(arg0 + 52, true);
            var result13 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr13, len13));
            variant14 = result13;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant15 = {
          requiredFeatures: variant5,
          requiredLimits: variant9,
          defaultQueue: variant12,
          label: variant14,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-adapter.request-device"] [Instruction::CallInterface] (async, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: true,
        entryFnName: 'requestDevice',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    
    const started = await task.enter({ isHost: hostProvided });
    if (!started) {
      _debugLog('[Instruction::CallInterface] failed to enter task', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
      });
      throw new Error("failed to enter task");
    }
    
    
    let ret;
    try {
      const hostRet16 = await  _withGlobalCurrentTaskMetaAsync({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.requestDevice(variant15),
      })
      ;
      ret = hostRet16 !== null && typeof hostRet16 === 'object' && (hostRet16.tag === 'ok' || hostRet16.tag === 'err')
      ? hostRet16
      : { tag: 'ok', val: hostRet16};
    } catch (e) {
      if (getOrCreateAsyncState(0).markTrapped(e)) { throw e; }
      ret = { tag: 'err', val: getErrorPayload(e) };
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    var variant21 = ret;
    let variant21_0;
    let variant21_1;
    let variant21_2;
    let variant21_3;
    switch (variant21.tag) {
      case 'ok': {
        const e = variant21.val;
        
        if (!(e instanceof GpuDevice)) {
          throw new TypeError('Resource error: Not a valid \"GpuDevice\" resource.');
        }
        var handle17 = e[symbolRscHandle];
        if (!handle17) {
          const rep = e[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, e);
          handle17 = rscTableCreateOwn(handleTable3, rep);
        }
        
        variant21_0 = 0;
        variant21_1 = handle17;
        variant21_2 = 0;
        variant21_3 = 0;
        
        break;
      }
      case 'err': {
        const e = variant21.val;
        var {kind: v18_0, message: v18_1 } = e;
        var variant19 = v18_0;
        let variant19_0;
        switch (variant19.tag) {
          case 'type-error': {
            variant19_0 = 0;
            break;
          }
          case 'operation-error': {
            variant19_0 = 1;
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant19.tag)}\` (received \`${variant19}\`) specified for \`RequestDeviceErrorKind\``);
          }
        }
        
        var encodeRes = await _utf8AllocateAndEncodeAsync(v18_1, realloc0Async, memory0);
        var ptr20= encodeRes.ptr;
        var len20 = encodeRes.len;
        
        variant21_0 = 1;
        variant21_1 = variant19_0;
        variant21_2 = ptr20;
        variant21_3 = len20;
        
        break;
      }
      default: {
        _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant21, valueType: typeof variant21});
        throw new TypeError('invalid variant specified for result');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-adapter.request-device"][Instruction::AsyncTaskReturn]', {
      funcName: '[task-return][method]gpu-adapter.request-device',
      paramCount: 4,
      componentIdx: 0,
      postReturn: false,
      hostProvided,
    });
    
    if (hostProvided) {
      _debugLog('[Instruction::AsyncTaskReturn] signaling host-provided async return completion', {
        task: task.id(),
        subtask: subtask?.id(),
        result: ret,
      })
      task.resolve([ret]);
      task.exit();
      return ret;
    }
    
    const componentState = getOrCreateAsyncState(0);
    if (!componentState) { throw new Error('failed to lookup current component state'); }
    
    queueMicrotask(async (resolve, reject) => {
      try {
        _debugLog("[Instruction::AsyncTaskReturn] starting driver loop", {
          fnName: '[task-return][method]gpu-adapter.request-device',
          componentInstanceIdx: 0,
          taskID: task.id(),
        });
        await _driverLoop({
          componentInstanceIdx: 0,
          componentState,
          task,
          fnName: '[task-return][method]gpu-adapter.request-device',
          isAsync: true,
          callbackResult: ret,
        });
      } catch (err) {
        _debugLog("[Instruction::AsyncTaskReturn] driver loop call failure", { err });
      }
    });
    
    let taskRes = await task.completionPromise();
    if (task.getErrHandling() === 'throw-result-err') {
      if (typeof taskRes !== 'object') {
        return taskRes;
      }
      if (taskRes.tag === 'err') { throw new ComponentError(taskRes.val);}
      if (taskRes.tag === 'ok') { taskRes = taskRes.val; }
    }
    
    return taskRes;
    
  }
  _trampoline61.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#requestDevice';
  
  const handleTable4 = [T_FLAG, 0];
  handleTable4._createdReps = new Set();
  
  
  const captureTable4= new Map();
  let captureCnt4= 0;
  
  HANDLE_TABLES[4] = handleTable4;
  
  const handleTable5 = [T_FLAG, 0];
  handleTable5._createdReps = new Set();
  
  
  const captureTable5= new Map();
  let captureCnt5= 0;
  
  HANDLE_TABLES[5] = handleTable5;
  
  const handleTable6 = [T_FLAG, 0];
  handleTable6._createdReps = new Set();
  
  
  const captureTable6= new Map();
  let captureCnt6= 0;
  
  HANDLE_TABLES[6] = handleTable6;
  
  const _trampoline62 = function(arg0) {
    var handle1 = dataView(memory0).getInt32(arg0 + 0, true);
    
    var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable4.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuCommandEncoder.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var len15 = dataView(memory0).getUint32(arg0 + 12, true);
    var base15 = dataView(memory0).getUint32(arg0 + 8, true);
    if (base15 % 8 !== 0) throw new TypeError(`list pointer [${base15}] is not aligned to 8`);
    var result15 = [];
    for (let i = 0; i < len15; i++) {
      const base = base15 + i * 80;
      let variant14;
      switch (dataView(memory0).getUint8(base + 0, true)) {
        case 0: {
          variant14 = undefined;
          break;
        }
        case 1: {
          var handle4 = dataView(memory0).getInt32(base + 8, true);
          
          var rep5 = handleTable5[(handle4 << 1) + 1] & ~T_FLAG;
          var rsc3 = captureTable5.get(rep5);
          if (!rsc3) {
            rsc3 = Object.create(GpuTextureView.prototype);
            Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
            Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
          }
          
          curResourceBorrows.push(rsc3);
          let variant6;
          switch (dataView(memory0).getUint8(base + 12, true)) {
            case 0: {
              variant6 = undefined;
              break;
            }
            case 1: {
              variant6 = dataView(memory0).getInt32(base + 16, true) >>> 0;
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          let variant10;
          switch (dataView(memory0).getUint8(base + 20, true)) {
            case 0: {
              variant10 = undefined;
              break;
            }
            case 1: {
              var handle8 = dataView(memory0).getInt32(base + 24, true);
              
              var rep9 = handleTable5[(handle8 << 1) + 1] & ~T_FLAG;
              var rsc7 = captureTable5.get(rep9);
              if (!rsc7) {
                rsc7 = Object.create(GpuTextureView.prototype);
                Object.defineProperty(rsc7, symbolRscHandle, { writable: true, value: handle8});
                Object.defineProperty(rsc7, symbolRscRep, { writable: true, value: rep9});
              }
              
              curResourceBorrows.push(rsc7);
              variant10 = rsc7;
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          let variant11;
          switch (dataView(memory0).getUint8(base + 32, true)) {
            case 0: {
              variant11 = undefined;
              break;
            }
            case 1: {
              variant11 = {
                r: dataView(memory0).getFloat64(base + 40, true),
                g: dataView(memory0).getFloat64(base + 48, true),
                b: dataView(memory0).getFloat64(base + 56, true),
                a: dataView(memory0).getFloat64(base + 64, true),
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          let enum12;
          switch (dataView(memory0).getUint8(base + 72, true)) {
            case 0: {
              enum12 = 'load';
              break;
            }
            case 1: {
              enum12 = 'clear';
              break;
            }
            default: {
              throw new TypeError('invalid discriminant specified for GpuLoadOp');
            }
          }
          let enum13;
          switch (dataView(memory0).getUint8(base + 73, true)) {
            case 0: {
              enum13 = 'store';
              break;
            }
            case 1: {
              enum13 = 'discard';
              break;
            }
            default: {
              throw new TypeError('invalid discriminant specified for GpuStoreOp');
            }
          }
          variant14 = {
            view: rsc3,
            depthSlice: variant6,
            resolveTarget: variant10,
            clearValue: variant11,
            loadOp: enum12,
            storeOp: enum13,
          };
          break;
        }
        default: {
          throw new TypeError('invalid variant discriminant for option');
        }
      }
      result15.push(variant14);
    }
    let variant33;
    switch (dataView(memory0).getUint8(arg0 + 16, true)) {
      case 0: {
        variant33 = undefined;
        break;
      }
      case 1: {
        var handle17 = dataView(memory0).getInt32(arg0 + 20, true);
        
        var rep18 = handleTable5[(handle17 << 1) + 1] & ~T_FLAG;
        var rsc16 = captureTable5.get(rep18);
        if (!rsc16) {
          rsc16 = Object.create(GpuTextureView.prototype);
          Object.defineProperty(rsc16, symbolRscHandle, { writable: true, value: handle17});
          Object.defineProperty(rsc16, symbolRscRep, { writable: true, value: rep18});
        }
        
        curResourceBorrows.push(rsc16);
        let variant19;
        switch (dataView(memory0).getUint8(arg0 + 24, true)) {
          case 0: {
            variant19 = undefined;
            break;
          }
          case 1: {
            variant19 = dataView(memory0).getFloat32(arg0 + 28, true);
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant21;
        switch (dataView(memory0).getUint8(arg0 + 32, true)) {
          case 0: {
            variant21 = undefined;
            break;
          }
          case 1: {
            let enum20;
            switch (dataView(memory0).getUint8(arg0 + 33, true)) {
              case 0: {
                enum20 = 'load';
                break;
              }
              case 1: {
                enum20 = 'clear';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuLoadOp');
              }
            }
            variant21 = enum20;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant23;
        switch (dataView(memory0).getUint8(arg0 + 34, true)) {
          case 0: {
            variant23 = undefined;
            break;
          }
          case 1: {
            let enum22;
            switch (dataView(memory0).getUint8(arg0 + 35, true)) {
              case 0: {
                enum22 = 'store';
                break;
              }
              case 1: {
                enum22 = 'discard';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuStoreOp');
              }
            }
            variant23 = enum22;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant25;
        switch (dataView(memory0).getUint8(arg0 + 36, true)) {
          case 0: {
            variant25 = undefined;
            break;
          }
          case 1: {
            var bool24 = dataView(memory0).getUint8(arg0 + 37, true);
            variant25 = bool24 == 0 ? false : (bool24 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant26;
        switch (dataView(memory0).getUint8(arg0 + 40, true)) {
          case 0: {
            variant26 = undefined;
            break;
          }
          case 1: {
            variant26 = dataView(memory0).getInt32(arg0 + 44, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant28;
        switch (dataView(memory0).getUint8(arg0 + 48, true)) {
          case 0: {
            variant28 = undefined;
            break;
          }
          case 1: {
            let enum27;
            switch (dataView(memory0).getUint8(arg0 + 49, true)) {
              case 0: {
                enum27 = 'load';
                break;
              }
              case 1: {
                enum27 = 'clear';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuLoadOp');
              }
            }
            variant28 = enum27;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant30;
        switch (dataView(memory0).getUint8(arg0 + 50, true)) {
          case 0: {
            variant30 = undefined;
            break;
          }
          case 1: {
            let enum29;
            switch (dataView(memory0).getUint8(arg0 + 51, true)) {
              case 0: {
                enum29 = 'store';
                break;
              }
              case 1: {
                enum29 = 'discard';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuStoreOp');
              }
            }
            variant30 = enum29;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant32;
        switch (dataView(memory0).getUint8(arg0 + 52, true)) {
          case 0: {
            variant32 = undefined;
            break;
          }
          case 1: {
            var bool31 = dataView(memory0).getUint8(arg0 + 53, true);
            variant32 = bool31 == 0 ? false : (bool31 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant33 = {
          view: rsc16,
          depthClearValue: variant19,
          depthLoadOp: variant21,
          depthStoreOp: variant23,
          depthReadOnly: variant25,
          stencilClearValue: variant26,
          stencilLoadOp: variant28,
          stencilStoreOp: variant30,
          stencilReadOnly: variant32,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant37;
    switch (dataView(memory0).getUint8(arg0 + 56, true)) {
      case 0: {
        variant37 = undefined;
        break;
      }
      case 1: {
        var handle35 = dataView(memory0).getInt32(arg0 + 60, true);
        
        var rep36 = handleTable6[(handle35 << 1) + 1] & ~T_FLAG;
        var rsc34 = captureTable6.get(rep36);
        if (!rsc34) {
          rsc34 = Object.create(GpuQuerySet.prototype);
          Object.defineProperty(rsc34, symbolRscHandle, { writable: true, value: handle35});
          Object.defineProperty(rsc34, symbolRscRep, { writable: true, value: rep36});
        }
        
        curResourceBorrows.push(rsc34);
        variant37 = rsc34;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant43;
    switch (dataView(memory0).getUint8(arg0 + 64, true)) {
      case 0: {
        variant43 = undefined;
        break;
      }
      case 1: {
        var handle39 = dataView(memory0).getInt32(arg0 + 68, true);
        
        var rep40 = handleTable6[(handle39 << 1) + 1] & ~T_FLAG;
        var rsc38 = captureTable6.get(rep40);
        if (!rsc38) {
          rsc38 = Object.create(GpuQuerySet.prototype);
          Object.defineProperty(rsc38, symbolRscHandle, { writable: true, value: handle39});
          Object.defineProperty(rsc38, symbolRscRep, { writable: true, value: rep40});
        }
        
        curResourceBorrows.push(rsc38);
        let variant41;
        switch (dataView(memory0).getUint8(arg0 + 72, true)) {
          case 0: {
            variant41 = undefined;
            break;
          }
          case 1: {
            variant41 = dataView(memory0).getInt32(arg0 + 76, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant42;
        switch (dataView(memory0).getUint8(arg0 + 80, true)) {
          case 0: {
            variant42 = undefined;
            break;
          }
          case 1: {
            variant42 = dataView(memory0).getInt32(arg0 + 84, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant43 = {
          querySet: rsc38,
          beginningOfPassWriteIndex: variant41,
          endOfPassWriteIndex: variant42,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant44;
    switch (dataView(memory0).getUint8(arg0 + 88, true)) {
      case 0: {
        variant44 = undefined;
        break;
      }
      case 1: {
        variant44 = BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(arg0 + 96, true)));
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant46;
    switch (dataView(memory0).getUint8(arg0 + 104, true)) {
      case 0: {
        variant46 = undefined;
        break;
      }
      case 1: {
        var ptr45 = dataView(memory0).getUint32(arg0 + 108, true);
        var len45 = dataView(memory0).getUint32(arg0 + 112, true);
        var result45 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr45, len45));
        variant46 = result45;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-command-encoder.begin-render-pass"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'beginRenderPass',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.beginRenderPass({
          colorAttachments: result15,
          depthStencilAttachment: variant33,
          occlusionQuerySet: variant37,
          timestampWrites: variant43,
          maxDrawCount: variant44,
          label: variant46,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuRenderPassEncoder)) {
      throw new TypeError('Resource error: Not a valid \"GpuRenderPassEncoder\" resource.');
    }
    var handle47 = ret[symbolRscHandle];
    if (!handle47) {
      const rep = ret[symbolRscRep] || ++captureCnt7;
      captureTable7.set(rep, ret);
      handle47 = rscTableCreateOwn(handleTable7, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-command-encoder.begin-render-pass"][Instruction::Return]', {
      funcName: '[method]gpu-command-encoder.begin-render-pass',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle47]);
    task.exit();
    return handle47;
  }
  _trampoline62.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#beginRenderPass';
  
  const handleTable8 = [T_FLAG, 0];
  handleTable8._createdReps = new Set();
  
  
  const captureTable8= new Map();
  let captureCnt8= 0;
  
  HANDLE_TABLES[8] = handleTable8;
  
  const _trampoline63 = function(arg0, arg1, arg2, arg3, arg4) {
    var handle1 = arg0;
    
    var rep2 = handleTable4[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable4.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuCommandEncoder.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant5;
    switch (arg1) {
      case 0: {
        variant5 = undefined;
        break;
      }
      case 1: {
        let variant4;
        switch (arg2) {
          case 0: {
            variant4 = undefined;
            break;
          }
          case 1: {
            var ptr3 = arg3;
            var len3 = arg4;
            var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
            variant4 = result3;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant5 = {
          label: variant4,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-command-encoder.finish"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'finish',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.finish(variant5),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuCommandBuffer)) {
      throw new TypeError('Resource error: Not a valid \"GpuCommandBuffer\" resource.');
    }
    var handle6 = ret[symbolRscHandle];
    if (!handle6) {
      const rep = ret[symbolRscRep] || ++captureCnt8;
      captureTable8.set(rep, ret);
      handle6 = rscTableCreateOwn(handleTable8, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-command-encoder.finish"][Instruction::Return]', {
      funcName: '[method]gpu-command-encoder.finish',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle6]);
    task.exit();
    return handle6;
  }
  _trampoline63.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#finish';
  
  const handleTable10 = [T_FLAG, 0];
  handleTable10._createdReps = new Set();
  
  
  const captureTable10= new Map();
  let captureCnt10= 0;
  
  HANDLE_TABLES[10] = handleTable10;
  
  const handleTable11 = [T_FLAG, 0];
  handleTable11._createdReps = new Set();
  
  
  const captureTable11= new Map();
  let captureCnt11= 0;
  
  HANDLE_TABLES[11] = handleTable11;
  
  const _trampoline64 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var len7 = arg2;
    var base7 = arg1;
    if (base7 % 4 !== 0) throw new TypeError(`list pointer [${base7}] is not aligned to 4`);
    var result7 = [];
    for (let i = 0; i < len7; i++) {
      const base = base7 + i * 8;
      let variant6;
      switch (dataView(memory0).getUint8(base + 0, true)) {
        case 0: {
          variant6 = undefined;
          break;
        }
        case 1: {
          var handle4 = dataView(memory0).getInt32(base + 4, true);
          
          var rep5 = handleTable10[(handle4 << 1) + 1] & ~T_FLAG;
          var rsc3 = captureTable10.get(rep5);
          if (!rsc3) {
            rsc3 = Object.create(GpuBindGroupLayout.prototype);
            Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
            Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
          }
          
          curResourceBorrows.push(rsc3);
          variant6 = rsc3;
          break;
        }
        default: {
          throw new TypeError('invalid variant discriminant for option');
        }
      }
      result7.push(variant6);
    }
    let variant8;
    switch (arg3) {
      case 0: {
        variant8 = undefined;
        break;
      }
      case 1: {
        variant8 = arg4 >>> 0;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant10;
    switch (arg5) {
      case 0: {
        variant10 = undefined;
        break;
      }
      case 1: {
        var ptr9 = arg6;
        var len9 = arg7;
        var result9 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr9, len9));
        variant10 = result9;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-pipeline-layout"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'createPipelineLayout',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.createPipelineLayout({
          bindGroupLayouts: result7,
          immediateSize: variant8,
          label: variant10,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuPipelineLayout)) {
      throw new TypeError('Resource error: Not a valid \"GpuPipelineLayout\" resource.');
    }
    var handle11 = ret[symbolRscHandle];
    if (!handle11) {
      const rep = ret[symbolRscRep] || ++captureCnt11;
      captureTable11.set(rep, ret);
      handle11 = rscTableCreateOwn(handleTable11, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-pipeline-layout"][Instruction::Return]', {
      funcName: '[method]gpu-device.create-pipeline-layout',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle11]);
    task.exit();
    return handle11;
  }
  _trampoline64.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#createPipelineLayout';
  
  const handleTable12 = [T_FLAG, 0];
  handleTable12._createdReps = new Set();
  
  
  const captureTable12= new Map();
  let captureCnt12= 0;
  
  HANDLE_TABLES[12] = handleTable12;
  
  const _trampoline65 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var ptr3 = arg1;
    var len3 = arg2;
    var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
    let variant11;
    switch (arg3) {
      case 0: {
        variant11 = undefined;
        break;
      }
      case 1: {
        var len10 = arg5;
        var base10 = arg4;
        if (base10 % 4 !== 0) throw new TypeError(`list pointer [${base10}] is not aligned to 4`);
        var result10 = [];
        for (let i = 0; i < len10; i++) {
          const base = base10 + i * 20;
          var ptr4 = dataView(memory0).getUint32(base + 0, true);
          var len4 = dataView(memory0).getUint32(base + 4, true);
          var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
          let variant9;
          switch (dataView(memory0).getUint8(base + 8, true)) {
            case 0: {
              variant9 = undefined;
              break;
            }
            case 1: {
              let variant8;
              switch (dataView(memory0).getUint8(base + 12, true)) {
                case 0: {
                  var handle6 = dataView(memory0).getInt32(base + 16, true);
                  
                  var rep7 = handleTable11[(handle6 << 1) + 1] & ~T_FLAG;
                  var rsc5 = captureTable11.get(rep7);
                  if (!rsc5) {
                    rsc5 = Object.create(GpuPipelineLayout.prototype);
                    Object.defineProperty(rsc5, symbolRscHandle, { writable: true, value: handle6});
                    Object.defineProperty(rsc5, symbolRscRep, { writable: true, value: rep7});
                  }
                  
                  curResourceBorrows.push(rsc5);
                  variant8= {
                    tag: 'specific',
                    val: rsc5
                  };
                  break;
                }
                case 1: {
                  variant8= {
                    tag: 'auto',
                  };
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for GpuLayoutMode');
                }
              }
              variant9 = variant8;
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          result10.push({
            entryPoint: result4,
            layout: variant9,
          });
        }
        variant11 = result10;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant13;
    switch (arg6) {
      case 0: {
        variant13 = undefined;
        break;
      }
      case 1: {
        var ptr12 = arg7;
        var len12 = arg8;
        var result12 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr12, len12));
        variant13 = result12;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-shader-module"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'createShaderModule',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.createShaderModule({
          code: result3,
          compilationHints: variant11,
          label: variant13,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuShaderModule)) {
      throw new TypeError('Resource error: Not a valid \"GpuShaderModule\" resource.');
    }
    var handle14 = ret[symbolRscHandle];
    if (!handle14) {
      const rep = ret[symbolRscRep] || ++captureCnt12;
      captureTable12.set(rep, ret);
      handle14 = rscTableCreateOwn(handleTable12, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-shader-module"][Instruction::Return]', {
      funcName: '[method]gpu-device.create-shader-module',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle14]);
    task.exit();
    return handle14;
  }
  _trampoline65.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#createShaderModule';
  
  const handleTable13 = [T_FLAG, 0];
  handleTable13._createdReps = new Set();
  
  
  const captureTable13= new Map();
  let captureCnt13= 0;
  
  HANDLE_TABLES[13] = handleTable13;
  
  const _trampoline66 = function(arg0) {
    var handle1 = dataView(memory0).getInt32(arg0 + 0, true);
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant9;
    switch (dataView(memory0).getUint8(arg0 + 4, true)) {
      case 0: {
        variant9 = undefined;
        break;
      }
      case 1: {
        var len8 = dataView(memory0).getUint32(arg0 + 12, true);
        var base8 = dataView(memory0).getUint32(arg0 + 8, true);
        if (base8 % 8 !== 0) throw new TypeError(`list pointer [${base8}] is not aligned to 8`);
        var result8 = [];
        for (let i = 0; i < len8; i++) {
          const base = base8 + i * 32;
          let variant7;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              variant7 = undefined;
              break;
            }
            case 1: {
              let variant4;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant4 = undefined;
                  break;
                }
                case 1: {
                  let enum3;
                  switch (dataView(memory0).getUint8(base + 17, true)) {
                    case 0: {
                      enum3 = 'vertex';
                      break;
                    }
                    case 1: {
                      enum3 = 'instance';
                      break;
                    }
                    default: {
                      throw new TypeError('invalid discriminant specified for GpuVertexStepMode');
                    }
                  }
                  variant4 = enum3;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              var len6 = dataView(memory0).getUint32(base + 24, true);
              var base6 = dataView(memory0).getUint32(base + 20, true);
              if (base6 % 8 !== 0) throw new TypeError(`list pointer [${base6}] is not aligned to 8`);
              var result6 = [];
              for (let i = 0; i < len6; i++) {
                const base = base6 + i * 24;
                let enum5;
                switch (dataView(memory0).getUint8(base + 0, true)) {
                  case 0: {
                    enum5 = 'uint8';
                    break;
                  }
                  case 1: {
                    enum5 = 'uint8x2';
                    break;
                  }
                  case 2: {
                    enum5 = 'uint8x4';
                    break;
                  }
                  case 3: {
                    enum5 = 'sint8';
                    break;
                  }
                  case 4: {
                    enum5 = 'sint8x2';
                    break;
                  }
                  case 5: {
                    enum5 = 'sint8x4';
                    break;
                  }
                  case 6: {
                    enum5 = 'unorm8';
                    break;
                  }
                  case 7: {
                    enum5 = 'unorm8x2';
                    break;
                  }
                  case 8: {
                    enum5 = 'unorm8x4';
                    break;
                  }
                  case 9: {
                    enum5 = 'snorm8';
                    break;
                  }
                  case 10: {
                    enum5 = 'snorm8x2';
                    break;
                  }
                  case 11: {
                    enum5 = 'snorm8x4';
                    break;
                  }
                  case 12: {
                    enum5 = 'uint16';
                    break;
                  }
                  case 13: {
                    enum5 = 'uint16x2';
                    break;
                  }
                  case 14: {
                    enum5 = 'uint16x4';
                    break;
                  }
                  case 15: {
                    enum5 = 'sint16';
                    break;
                  }
                  case 16: {
                    enum5 = 'sint16x2';
                    break;
                  }
                  case 17: {
                    enum5 = 'sint16x4';
                    break;
                  }
                  case 18: {
                    enum5 = 'unorm16';
                    break;
                  }
                  case 19: {
                    enum5 = 'unorm16x2';
                    break;
                  }
                  case 20: {
                    enum5 = 'unorm16x4';
                    break;
                  }
                  case 21: {
                    enum5 = 'snorm16';
                    break;
                  }
                  case 22: {
                    enum5 = 'snorm16x2';
                    break;
                  }
                  case 23: {
                    enum5 = 'snorm16x4';
                    break;
                  }
                  case 24: {
                    enum5 = 'float16';
                    break;
                  }
                  case 25: {
                    enum5 = 'float16x2';
                    break;
                  }
                  case 26: {
                    enum5 = 'float16x4';
                    break;
                  }
                  case 27: {
                    enum5 = 'float32';
                    break;
                  }
                  case 28: {
                    enum5 = 'float32x2';
                    break;
                  }
                  case 29: {
                    enum5 = 'float32x3';
                    break;
                  }
                  case 30: {
                    enum5 = 'float32x4';
                    break;
                  }
                  case 31: {
                    enum5 = 'uint32';
                    break;
                  }
                  case 32: {
                    enum5 = 'uint32x2';
                    break;
                  }
                  case 33: {
                    enum5 = 'uint32x3';
                    break;
                  }
                  case 34: {
                    enum5 = 'uint32x4';
                    break;
                  }
                  case 35: {
                    enum5 = 'sint32';
                    break;
                  }
                  case 36: {
                    enum5 = 'sint32x2';
                    break;
                  }
                  case 37: {
                    enum5 = 'sint32x3';
                    break;
                  }
                  case 38: {
                    enum5 = 'sint32x4';
                    break;
                  }
                  case 39: {
                    enum5 = 'unorm1010102';
                    break;
                  }
                  case 40: {
                    enum5 = 'unorm8x4-bgra';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuVertexFormat');
                  }
                }
                result6.push({
                  format: enum5,
                  offset: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                  shaderLocation: dataView(memory0).getInt32(base + 16, true) >>> 0,
                });
              }
              variant7 = {
                arrayStride: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 8, true))),
                stepMode: variant4,
                attributes: result6,
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          result8.push(variant7);
        }
        variant9 = result8;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    var handle11 = dataView(memory0).getInt32(arg0 + 16, true);
    
    var rep12 = handleTable12[(handle11 << 1) + 1] & ~T_FLAG;
    var rsc10 = captureTable12.get(rep12);
    if (!rsc10) {
      rsc10 = Object.create(GpuShaderModule.prototype);
      Object.defineProperty(rsc10, symbolRscHandle, { writable: true, value: handle11});
      Object.defineProperty(rsc10, symbolRscRep, { writable: true, value: rep12});
    }
    
    curResourceBorrows.push(rsc10);
    let variant14;
    switch (dataView(memory0).getUint8(arg0 + 20, true)) {
      case 0: {
        variant14 = undefined;
        break;
      }
      case 1: {
        var ptr13 = dataView(memory0).getUint32(arg0 + 24, true);
        var len13 = dataView(memory0).getUint32(arg0 + 28, true);
        var result13 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr13, len13));
        variant14 = result13;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant18;
    switch (dataView(memory0).getUint8(arg0 + 32, true)) {
      case 0: {
        variant18 = undefined;
        break;
      }
      case 1: {
        var handle16 = dataView(memory0).getInt32(arg0 + 36, true);
        
        var rep17 = handleTable13[(handle16 << 1) + 1] & ~T_FLAG;
        var rsc15 = captureTable13.get(rep17);
        if (!rsc15) {
          rsc15 = Object.create(RecordGpuPipelineConstantValue.prototype);
          Object.defineProperty(rsc15, symbolRscHandle, { writable: true, value: handle16});
          Object.defineProperty(rsc15, symbolRscRep, { writable: true, value: rep17});
        }
        
        else {
          captureTable13.delete(rep17);
        }
        rscTableRemove(handleTable13, handle16);
        variant18 = rsc15;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant29;
    switch (dataView(memory0).getUint8(arg0 + 40, true)) {
      case 0: {
        variant29 = undefined;
        break;
      }
      case 1: {
        let variant20;
        switch (dataView(memory0).getUint8(arg0 + 41, true)) {
          case 0: {
            variant20 = undefined;
            break;
          }
          case 1: {
            let enum19;
            switch (dataView(memory0).getUint8(arg0 + 42, true)) {
              case 0: {
                enum19 = 'point-list';
                break;
              }
              case 1: {
                enum19 = 'line-list';
                break;
              }
              case 2: {
                enum19 = 'line-strip';
                break;
              }
              case 3: {
                enum19 = 'triangle-list';
                break;
              }
              case 4: {
                enum19 = 'triangle-strip';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuPrimitiveTopology');
              }
            }
            variant20 = enum19;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant22;
        switch (dataView(memory0).getUint8(arg0 + 43, true)) {
          case 0: {
            variant22 = undefined;
            break;
          }
          case 1: {
            let enum21;
            switch (dataView(memory0).getUint8(arg0 + 44, true)) {
              case 0: {
                enum21 = 'uint16';
                break;
              }
              case 1: {
                enum21 = 'uint32';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuIndexFormat');
              }
            }
            variant22 = enum21;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant24;
        switch (dataView(memory0).getUint8(arg0 + 45, true)) {
          case 0: {
            variant24 = undefined;
            break;
          }
          case 1: {
            let enum23;
            switch (dataView(memory0).getUint8(arg0 + 46, true)) {
              case 0: {
                enum23 = 'ccw';
                break;
              }
              case 1: {
                enum23 = 'cw';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuFrontFace');
              }
            }
            variant24 = enum23;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant26;
        switch (dataView(memory0).getUint8(arg0 + 47, true)) {
          case 0: {
            variant26 = undefined;
            break;
          }
          case 1: {
            let enum25;
            switch (dataView(memory0).getUint8(arg0 + 48, true)) {
              case 0: {
                enum25 = 'none';
                break;
              }
              case 1: {
                enum25 = 'front';
                break;
              }
              case 2: {
                enum25 = 'back';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuCullMode');
              }
            }
            variant26 = enum25;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant28;
        switch (dataView(memory0).getUint8(arg0 + 49, true)) {
          case 0: {
            variant28 = undefined;
            break;
          }
          case 1: {
            var bool27 = dataView(memory0).getUint8(arg0 + 50, true);
            variant28 = bool27 == 0 ? false : (bool27 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant29 = {
          topology: variant20,
          stripIndexFormat: variant22,
          frontFace: variant24,
          cullMode: variant26,
          unclippedDepth: variant28,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant58;
    switch (dataView(memory0).getUint8(arg0 + 52, true)) {
      case 0: {
        variant58 = undefined;
        break;
      }
      case 1: {
        let enum30;
        switch (dataView(memory0).getUint8(arg0 + 56, true)) {
          case 0: {
            enum30 = 'r8unorm';
            break;
          }
          case 1: {
            enum30 = 'r8snorm';
            break;
          }
          case 2: {
            enum30 = 'r8uint';
            break;
          }
          case 3: {
            enum30 = 'r8sint';
            break;
          }
          case 4: {
            enum30 = 'r16unorm';
            break;
          }
          case 5: {
            enum30 = 'r16snorm';
            break;
          }
          case 6: {
            enum30 = 'r16uint';
            break;
          }
          case 7: {
            enum30 = 'r16sint';
            break;
          }
          case 8: {
            enum30 = 'r16float';
            break;
          }
          case 9: {
            enum30 = 'rg8unorm';
            break;
          }
          case 10: {
            enum30 = 'rg8snorm';
            break;
          }
          case 11: {
            enum30 = 'rg8uint';
            break;
          }
          case 12: {
            enum30 = 'rg8sint';
            break;
          }
          case 13: {
            enum30 = 'r32uint';
            break;
          }
          case 14: {
            enum30 = 'r32sint';
            break;
          }
          case 15: {
            enum30 = 'r32float';
            break;
          }
          case 16: {
            enum30 = 'rg16unorm';
            break;
          }
          case 17: {
            enum30 = 'rg16snorm';
            break;
          }
          case 18: {
            enum30 = 'rg16uint';
            break;
          }
          case 19: {
            enum30 = 'rg16sint';
            break;
          }
          case 20: {
            enum30 = 'rg16float';
            break;
          }
          case 21: {
            enum30 = 'rgba8unorm';
            break;
          }
          case 22: {
            enum30 = 'rgba8unorm-srgb';
            break;
          }
          case 23: {
            enum30 = 'rgba8snorm';
            break;
          }
          case 24: {
            enum30 = 'rgba8uint';
            break;
          }
          case 25: {
            enum30 = 'rgba8sint';
            break;
          }
          case 26: {
            enum30 = 'bgra8unorm';
            break;
          }
          case 27: {
            enum30 = 'bgra8unorm-srgb';
            break;
          }
          case 28: {
            enum30 = 'rgb9e5ufloat';
            break;
          }
          case 29: {
            enum30 = 'rgb10a2uint';
            break;
          }
          case 30: {
            enum30 = 'rgb10a2unorm';
            break;
          }
          case 31: {
            enum30 = 'rg11b10ufloat';
            break;
          }
          case 32: {
            enum30 = 'rg32uint';
            break;
          }
          case 33: {
            enum30 = 'rg32sint';
            break;
          }
          case 34: {
            enum30 = 'rg32float';
            break;
          }
          case 35: {
            enum30 = 'rgba16unorm';
            break;
          }
          case 36: {
            enum30 = 'rgba16snorm';
            break;
          }
          case 37: {
            enum30 = 'rgba16uint';
            break;
          }
          case 38: {
            enum30 = 'rgba16sint';
            break;
          }
          case 39: {
            enum30 = 'rgba16float';
            break;
          }
          case 40: {
            enum30 = 'rgba32uint';
            break;
          }
          case 41: {
            enum30 = 'rgba32sint';
            break;
          }
          case 42: {
            enum30 = 'rgba32float';
            break;
          }
          case 43: {
            enum30 = 'stencil8';
            break;
          }
          case 44: {
            enum30 = 'depth16unorm';
            break;
          }
          case 45: {
            enum30 = 'depth24plus';
            break;
          }
          case 46: {
            enum30 = 'depth24plus-stencil8';
            break;
          }
          case 47: {
            enum30 = 'depth32float';
            break;
          }
          case 48: {
            enum30 = 'depth32float-stencil8';
            break;
          }
          case 49: {
            enum30 = 'bc1-rgba-unorm';
            break;
          }
          case 50: {
            enum30 = 'bc1-rgba-unorm-srgb';
            break;
          }
          case 51: {
            enum30 = 'bc2-rgba-unorm';
            break;
          }
          case 52: {
            enum30 = 'bc2-rgba-unorm-srgb';
            break;
          }
          case 53: {
            enum30 = 'bc3-rgba-unorm';
            break;
          }
          case 54: {
            enum30 = 'bc3-rgba-unorm-srgb';
            break;
          }
          case 55: {
            enum30 = 'bc4-r-unorm';
            break;
          }
          case 56: {
            enum30 = 'bc4-r-snorm';
            break;
          }
          case 57: {
            enum30 = 'bc5-rg-unorm';
            break;
          }
          case 58: {
            enum30 = 'bc5-rg-snorm';
            break;
          }
          case 59: {
            enum30 = 'bc6h-rgb-ufloat';
            break;
          }
          case 60: {
            enum30 = 'bc6h-rgb-float';
            break;
          }
          case 61: {
            enum30 = 'bc7-rgba-unorm';
            break;
          }
          case 62: {
            enum30 = 'bc7-rgba-unorm-srgb';
            break;
          }
          case 63: {
            enum30 = 'etc2-rgb8unorm';
            break;
          }
          case 64: {
            enum30 = 'etc2-rgb8unorm-srgb';
            break;
          }
          case 65: {
            enum30 = 'etc2-rgb8a1unorm';
            break;
          }
          case 66: {
            enum30 = 'etc2-rgb8a1unorm-srgb';
            break;
          }
          case 67: {
            enum30 = 'etc2-rgba8unorm';
            break;
          }
          case 68: {
            enum30 = 'etc2-rgba8unorm-srgb';
            break;
          }
          case 69: {
            enum30 = 'eac-r11unorm';
            break;
          }
          case 70: {
            enum30 = 'eac-r11snorm';
            break;
          }
          case 71: {
            enum30 = 'eac-rg11unorm';
            break;
          }
          case 72: {
            enum30 = 'eac-rg11snorm';
            break;
          }
          case 73: {
            enum30 = 'astc4x4-unorm';
            break;
          }
          case 74: {
            enum30 = 'astc4x4-unorm-srgb';
            break;
          }
          case 75: {
            enum30 = 'astc5x4-unorm';
            break;
          }
          case 76: {
            enum30 = 'astc5x4-unorm-srgb';
            break;
          }
          case 77: {
            enum30 = 'astc5x5-unorm';
            break;
          }
          case 78: {
            enum30 = 'astc5x5-unorm-srgb';
            break;
          }
          case 79: {
            enum30 = 'astc6x5-unorm';
            break;
          }
          case 80: {
            enum30 = 'astc6x5-unorm-srgb';
            break;
          }
          case 81: {
            enum30 = 'astc6x6-unorm';
            break;
          }
          case 82: {
            enum30 = 'astc6x6-unorm-srgb';
            break;
          }
          case 83: {
            enum30 = 'astc8x5-unorm';
            break;
          }
          case 84: {
            enum30 = 'astc8x5-unorm-srgb';
            break;
          }
          case 85: {
            enum30 = 'astc8x6-unorm';
            break;
          }
          case 86: {
            enum30 = 'astc8x6-unorm-srgb';
            break;
          }
          case 87: {
            enum30 = 'astc8x8-unorm';
            break;
          }
          case 88: {
            enum30 = 'astc8x8-unorm-srgb';
            break;
          }
          case 89: {
            enum30 = 'astc10x5-unorm';
            break;
          }
          case 90: {
            enum30 = 'astc10x5-unorm-srgb';
            break;
          }
          case 91: {
            enum30 = 'astc10x6-unorm';
            break;
          }
          case 92: {
            enum30 = 'astc10x6-unorm-srgb';
            break;
          }
          case 93: {
            enum30 = 'astc10x8-unorm';
            break;
          }
          case 94: {
            enum30 = 'astc10x8-unorm-srgb';
            break;
          }
          case 95: {
            enum30 = 'astc10x10-unorm';
            break;
          }
          case 96: {
            enum30 = 'astc10x10-unorm-srgb';
            break;
          }
          case 97: {
            enum30 = 'astc12x10-unorm';
            break;
          }
          case 98: {
            enum30 = 'astc12x10-unorm-srgb';
            break;
          }
          case 99: {
            enum30 = 'astc12x12-unorm';
            break;
          }
          case 100: {
            enum30 = 'astc12x12-unorm-srgb';
            break;
          }
          default: {
            throw new TypeError('invalid discriminant specified for GpuTextureFormat');
          }
        }
        let variant32;
        switch (dataView(memory0).getUint8(arg0 + 57, true)) {
          case 0: {
            variant32 = undefined;
            break;
          }
          case 1: {
            var bool31 = dataView(memory0).getUint8(arg0 + 58, true);
            variant32 = bool31 == 0 ? false : (bool31 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant34;
        switch (dataView(memory0).getUint8(arg0 + 59, true)) {
          case 0: {
            variant34 = undefined;
            break;
          }
          case 1: {
            let enum33;
            switch (dataView(memory0).getUint8(arg0 + 60, true)) {
              case 0: {
                enum33 = 'never';
                break;
              }
              case 1: {
                enum33 = 'less';
                break;
              }
              case 2: {
                enum33 = 'equal';
                break;
              }
              case 3: {
                enum33 = 'less-equal';
                break;
              }
              case 4: {
                enum33 = 'greater';
                break;
              }
              case 5: {
                enum33 = 'not-equal';
                break;
              }
              case 6: {
                enum33 = 'greater-equal';
                break;
              }
              case 7: {
                enum33 = 'always';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuCompareFunction');
              }
            }
            variant34 = enum33;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant43;
        switch (dataView(memory0).getUint8(arg0 + 61, true)) {
          case 0: {
            variant43 = undefined;
            break;
          }
          case 1: {
            let variant36;
            switch (dataView(memory0).getUint8(arg0 + 62, true)) {
              case 0: {
                variant36 = undefined;
                break;
              }
              case 1: {
                let enum35;
                switch (dataView(memory0).getUint8(arg0 + 63, true)) {
                  case 0: {
                    enum35 = 'never';
                    break;
                  }
                  case 1: {
                    enum35 = 'less';
                    break;
                  }
                  case 2: {
                    enum35 = 'equal';
                    break;
                  }
                  case 3: {
                    enum35 = 'less-equal';
                    break;
                  }
                  case 4: {
                    enum35 = 'greater';
                    break;
                  }
                  case 5: {
                    enum35 = 'not-equal';
                    break;
                  }
                  case 6: {
                    enum35 = 'greater-equal';
                    break;
                  }
                  case 7: {
                    enum35 = 'always';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuCompareFunction');
                  }
                }
                variant36 = enum35;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant38;
            switch (dataView(memory0).getUint8(arg0 + 64, true)) {
              case 0: {
                variant38 = undefined;
                break;
              }
              case 1: {
                let enum37;
                switch (dataView(memory0).getUint8(arg0 + 65, true)) {
                  case 0: {
                    enum37 = 'keep';
                    break;
                  }
                  case 1: {
                    enum37 = 'zero';
                    break;
                  }
                  case 2: {
                    enum37 = 'replace';
                    break;
                  }
                  case 3: {
                    enum37 = 'invert';
                    break;
                  }
                  case 4: {
                    enum37 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum37 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum37 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum37 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant38 = enum37;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant40;
            switch (dataView(memory0).getUint8(arg0 + 66, true)) {
              case 0: {
                variant40 = undefined;
                break;
              }
              case 1: {
                let enum39;
                switch (dataView(memory0).getUint8(arg0 + 67, true)) {
                  case 0: {
                    enum39 = 'keep';
                    break;
                  }
                  case 1: {
                    enum39 = 'zero';
                    break;
                  }
                  case 2: {
                    enum39 = 'replace';
                    break;
                  }
                  case 3: {
                    enum39 = 'invert';
                    break;
                  }
                  case 4: {
                    enum39 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum39 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum39 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum39 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant40 = enum39;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant42;
            switch (dataView(memory0).getUint8(arg0 + 68, true)) {
              case 0: {
                variant42 = undefined;
                break;
              }
              case 1: {
                let enum41;
                switch (dataView(memory0).getUint8(arg0 + 69, true)) {
                  case 0: {
                    enum41 = 'keep';
                    break;
                  }
                  case 1: {
                    enum41 = 'zero';
                    break;
                  }
                  case 2: {
                    enum41 = 'replace';
                    break;
                  }
                  case 3: {
                    enum41 = 'invert';
                    break;
                  }
                  case 4: {
                    enum41 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum41 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum41 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum41 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant42 = enum41;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            variant43 = {
              compare: variant36,
              failOp: variant38,
              depthFailOp: variant40,
              passOp: variant42,
            };
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant52;
        switch (dataView(memory0).getUint8(arg0 + 70, true)) {
          case 0: {
            variant52 = undefined;
            break;
          }
          case 1: {
            let variant45;
            switch (dataView(memory0).getUint8(arg0 + 71, true)) {
              case 0: {
                variant45 = undefined;
                break;
              }
              case 1: {
                let enum44;
                switch (dataView(memory0).getUint8(arg0 + 72, true)) {
                  case 0: {
                    enum44 = 'never';
                    break;
                  }
                  case 1: {
                    enum44 = 'less';
                    break;
                  }
                  case 2: {
                    enum44 = 'equal';
                    break;
                  }
                  case 3: {
                    enum44 = 'less-equal';
                    break;
                  }
                  case 4: {
                    enum44 = 'greater';
                    break;
                  }
                  case 5: {
                    enum44 = 'not-equal';
                    break;
                  }
                  case 6: {
                    enum44 = 'greater-equal';
                    break;
                  }
                  case 7: {
                    enum44 = 'always';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuCompareFunction');
                  }
                }
                variant45 = enum44;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant47;
            switch (dataView(memory0).getUint8(arg0 + 73, true)) {
              case 0: {
                variant47 = undefined;
                break;
              }
              case 1: {
                let enum46;
                switch (dataView(memory0).getUint8(arg0 + 74, true)) {
                  case 0: {
                    enum46 = 'keep';
                    break;
                  }
                  case 1: {
                    enum46 = 'zero';
                    break;
                  }
                  case 2: {
                    enum46 = 'replace';
                    break;
                  }
                  case 3: {
                    enum46 = 'invert';
                    break;
                  }
                  case 4: {
                    enum46 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum46 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum46 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum46 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant47 = enum46;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant49;
            switch (dataView(memory0).getUint8(arg0 + 75, true)) {
              case 0: {
                variant49 = undefined;
                break;
              }
              case 1: {
                let enum48;
                switch (dataView(memory0).getUint8(arg0 + 76, true)) {
                  case 0: {
                    enum48 = 'keep';
                    break;
                  }
                  case 1: {
                    enum48 = 'zero';
                    break;
                  }
                  case 2: {
                    enum48 = 'replace';
                    break;
                  }
                  case 3: {
                    enum48 = 'invert';
                    break;
                  }
                  case 4: {
                    enum48 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum48 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum48 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum48 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant49 = enum48;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            let variant51;
            switch (dataView(memory0).getUint8(arg0 + 77, true)) {
              case 0: {
                variant51 = undefined;
                break;
              }
              case 1: {
                let enum50;
                switch (dataView(memory0).getUint8(arg0 + 78, true)) {
                  case 0: {
                    enum50 = 'keep';
                    break;
                  }
                  case 1: {
                    enum50 = 'zero';
                    break;
                  }
                  case 2: {
                    enum50 = 'replace';
                    break;
                  }
                  case 3: {
                    enum50 = 'invert';
                    break;
                  }
                  case 4: {
                    enum50 = 'increment-clamp';
                    break;
                  }
                  case 5: {
                    enum50 = 'decrement-clamp';
                    break;
                  }
                  case 6: {
                    enum50 = 'increment-wrap';
                    break;
                  }
                  case 7: {
                    enum50 = 'decrement-wrap';
                    break;
                  }
                  default: {
                    throw new TypeError('invalid discriminant specified for GpuStencilOperation');
                  }
                }
                variant51 = enum50;
                break;
              }
              default: {
                throw new TypeError('invalid variant discriminant for option');
              }
            }
            variant52 = {
              compare: variant45,
              failOp: variant47,
              depthFailOp: variant49,
              passOp: variant51,
            };
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant53;
        switch (dataView(memory0).getUint8(arg0 + 80, true)) {
          case 0: {
            variant53 = undefined;
            break;
          }
          case 1: {
            variant53 = dataView(memory0).getInt32(arg0 + 84, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant54;
        switch (dataView(memory0).getUint8(arg0 + 88, true)) {
          case 0: {
            variant54 = undefined;
            break;
          }
          case 1: {
            variant54 = dataView(memory0).getInt32(arg0 + 92, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant55;
        switch (dataView(memory0).getUint8(arg0 + 96, true)) {
          case 0: {
            variant55 = undefined;
            break;
          }
          case 1: {
            variant55 = dataView(memory0).getInt32(arg0 + 100, true);
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant56;
        switch (dataView(memory0).getUint8(arg0 + 104, true)) {
          case 0: {
            variant56 = undefined;
            break;
          }
          case 1: {
            variant56 = dataView(memory0).getFloat32(arg0 + 108, true);
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant57;
        switch (dataView(memory0).getUint8(arg0 + 112, true)) {
          case 0: {
            variant57 = undefined;
            break;
          }
          case 1: {
            variant57 = dataView(memory0).getFloat32(arg0 + 116, true);
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant58 = {
          format: enum30,
          depthWriteEnabled: variant32,
          depthCompare: variant34,
          stencilFront: variant43,
          stencilBack: variant52,
          stencilReadMask: variant53,
          stencilWriteMask: variant54,
          depthBias: variant55,
          depthBiasSlopeScale: variant56,
          depthBiasClamp: variant57,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant63;
    switch (dataView(memory0).getUint8(arg0 + 120, true)) {
      case 0: {
        variant63 = undefined;
        break;
      }
      case 1: {
        let variant59;
        switch (dataView(memory0).getUint8(arg0 + 124, true)) {
          case 0: {
            variant59 = undefined;
            break;
          }
          case 1: {
            variant59 = dataView(memory0).getInt32(arg0 + 128, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant60;
        switch (dataView(memory0).getUint8(arg0 + 132, true)) {
          case 0: {
            variant60 = undefined;
            break;
          }
          case 1: {
            variant60 = dataView(memory0).getInt32(arg0 + 136, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant62;
        switch (dataView(memory0).getUint8(arg0 + 140, true)) {
          case 0: {
            variant62 = undefined;
            break;
          }
          case 1: {
            var bool61 = dataView(memory0).getUint8(arg0 + 141, true);
            variant62 = bool61 == 0 ? false : (bool61 == 1 ? true : throwInvalidBool());
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant63 = {
          count: variant59,
          mask: variant60,
          alphaToCoverageEnabled: variant62,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant91;
    switch (dataView(memory0).getUint8(arg0 + 144, true)) {
      case 0: {
        variant91 = undefined;
        break;
      }
      case 1: {
        var len81 = dataView(memory0).getUint32(arg0 + 152, true);
        var base81 = dataView(memory0).getUint32(arg0 + 148, true);
        if (base81 % 1 !== 0) throw new TypeError(`list pointer [${base81}] is not aligned to 1`);
        var result81 = [];
        for (let i = 0; i < len81; i++) {
          const base = base81 + i * 17;
          let variant80;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              variant80 = undefined;
              break;
            }
            case 1: {
              let enum64;
              switch (dataView(memory0).getUint8(base + 1, true)) {
                case 0: {
                  enum64 = 'r8unorm';
                  break;
                }
                case 1: {
                  enum64 = 'r8snorm';
                  break;
                }
                case 2: {
                  enum64 = 'r8uint';
                  break;
                }
                case 3: {
                  enum64 = 'r8sint';
                  break;
                }
                case 4: {
                  enum64 = 'r16unorm';
                  break;
                }
                case 5: {
                  enum64 = 'r16snorm';
                  break;
                }
                case 6: {
                  enum64 = 'r16uint';
                  break;
                }
                case 7: {
                  enum64 = 'r16sint';
                  break;
                }
                case 8: {
                  enum64 = 'r16float';
                  break;
                }
                case 9: {
                  enum64 = 'rg8unorm';
                  break;
                }
                case 10: {
                  enum64 = 'rg8snorm';
                  break;
                }
                case 11: {
                  enum64 = 'rg8uint';
                  break;
                }
                case 12: {
                  enum64 = 'rg8sint';
                  break;
                }
                case 13: {
                  enum64 = 'r32uint';
                  break;
                }
                case 14: {
                  enum64 = 'r32sint';
                  break;
                }
                case 15: {
                  enum64 = 'r32float';
                  break;
                }
                case 16: {
                  enum64 = 'rg16unorm';
                  break;
                }
                case 17: {
                  enum64 = 'rg16snorm';
                  break;
                }
                case 18: {
                  enum64 = 'rg16uint';
                  break;
                }
                case 19: {
                  enum64 = 'rg16sint';
                  break;
                }
                case 20: {
                  enum64 = 'rg16float';
                  break;
                }
                case 21: {
                  enum64 = 'rgba8unorm';
                  break;
                }
                case 22: {
                  enum64 = 'rgba8unorm-srgb';
                  break;
                }
                case 23: {
                  enum64 = 'rgba8snorm';
                  break;
                }
                case 24: {
                  enum64 = 'rgba8uint';
                  break;
                }
                case 25: {
                  enum64 = 'rgba8sint';
                  break;
                }
                case 26: {
                  enum64 = 'bgra8unorm';
                  break;
                }
                case 27: {
                  enum64 = 'bgra8unorm-srgb';
                  break;
                }
                case 28: {
                  enum64 = 'rgb9e5ufloat';
                  break;
                }
                case 29: {
                  enum64 = 'rgb10a2uint';
                  break;
                }
                case 30: {
                  enum64 = 'rgb10a2unorm';
                  break;
                }
                case 31: {
                  enum64 = 'rg11b10ufloat';
                  break;
                }
                case 32: {
                  enum64 = 'rg32uint';
                  break;
                }
                case 33: {
                  enum64 = 'rg32sint';
                  break;
                }
                case 34: {
                  enum64 = 'rg32float';
                  break;
                }
                case 35: {
                  enum64 = 'rgba16unorm';
                  break;
                }
                case 36: {
                  enum64 = 'rgba16snorm';
                  break;
                }
                case 37: {
                  enum64 = 'rgba16uint';
                  break;
                }
                case 38: {
                  enum64 = 'rgba16sint';
                  break;
                }
                case 39: {
                  enum64 = 'rgba16float';
                  break;
                }
                case 40: {
                  enum64 = 'rgba32uint';
                  break;
                }
                case 41: {
                  enum64 = 'rgba32sint';
                  break;
                }
                case 42: {
                  enum64 = 'rgba32float';
                  break;
                }
                case 43: {
                  enum64 = 'stencil8';
                  break;
                }
                case 44: {
                  enum64 = 'depth16unorm';
                  break;
                }
                case 45: {
                  enum64 = 'depth24plus';
                  break;
                }
                case 46: {
                  enum64 = 'depth24plus-stencil8';
                  break;
                }
                case 47: {
                  enum64 = 'depth32float';
                  break;
                }
                case 48: {
                  enum64 = 'depth32float-stencil8';
                  break;
                }
                case 49: {
                  enum64 = 'bc1-rgba-unorm';
                  break;
                }
                case 50: {
                  enum64 = 'bc1-rgba-unorm-srgb';
                  break;
                }
                case 51: {
                  enum64 = 'bc2-rgba-unorm';
                  break;
                }
                case 52: {
                  enum64 = 'bc2-rgba-unorm-srgb';
                  break;
                }
                case 53: {
                  enum64 = 'bc3-rgba-unorm';
                  break;
                }
                case 54: {
                  enum64 = 'bc3-rgba-unorm-srgb';
                  break;
                }
                case 55: {
                  enum64 = 'bc4-r-unorm';
                  break;
                }
                case 56: {
                  enum64 = 'bc4-r-snorm';
                  break;
                }
                case 57: {
                  enum64 = 'bc5-rg-unorm';
                  break;
                }
                case 58: {
                  enum64 = 'bc5-rg-snorm';
                  break;
                }
                case 59: {
                  enum64 = 'bc6h-rgb-ufloat';
                  break;
                }
                case 60: {
                  enum64 = 'bc6h-rgb-float';
                  break;
                }
                case 61: {
                  enum64 = 'bc7-rgba-unorm';
                  break;
                }
                case 62: {
                  enum64 = 'bc7-rgba-unorm-srgb';
                  break;
                }
                case 63: {
                  enum64 = 'etc2-rgb8unorm';
                  break;
                }
                case 64: {
                  enum64 = 'etc2-rgb8unorm-srgb';
                  break;
                }
                case 65: {
                  enum64 = 'etc2-rgb8a1unorm';
                  break;
                }
                case 66: {
                  enum64 = 'etc2-rgb8a1unorm-srgb';
                  break;
                }
                case 67: {
                  enum64 = 'etc2-rgba8unorm';
                  break;
                }
                case 68: {
                  enum64 = 'etc2-rgba8unorm-srgb';
                  break;
                }
                case 69: {
                  enum64 = 'eac-r11unorm';
                  break;
                }
                case 70: {
                  enum64 = 'eac-r11snorm';
                  break;
                }
                case 71: {
                  enum64 = 'eac-rg11unorm';
                  break;
                }
                case 72: {
                  enum64 = 'eac-rg11snorm';
                  break;
                }
                case 73: {
                  enum64 = 'astc4x4-unorm';
                  break;
                }
                case 74: {
                  enum64 = 'astc4x4-unorm-srgb';
                  break;
                }
                case 75: {
                  enum64 = 'astc5x4-unorm';
                  break;
                }
                case 76: {
                  enum64 = 'astc5x4-unorm-srgb';
                  break;
                }
                case 77: {
                  enum64 = 'astc5x5-unorm';
                  break;
                }
                case 78: {
                  enum64 = 'astc5x5-unorm-srgb';
                  break;
                }
                case 79: {
                  enum64 = 'astc6x5-unorm';
                  break;
                }
                case 80: {
                  enum64 = 'astc6x5-unorm-srgb';
                  break;
                }
                case 81: {
                  enum64 = 'astc6x6-unorm';
                  break;
                }
                case 82: {
                  enum64 = 'astc6x6-unorm-srgb';
                  break;
                }
                case 83: {
                  enum64 = 'astc8x5-unorm';
                  break;
                }
                case 84: {
                  enum64 = 'astc8x5-unorm-srgb';
                  break;
                }
                case 85: {
                  enum64 = 'astc8x6-unorm';
                  break;
                }
                case 86: {
                  enum64 = 'astc8x6-unorm-srgb';
                  break;
                }
                case 87: {
                  enum64 = 'astc8x8-unorm';
                  break;
                }
                case 88: {
                  enum64 = 'astc8x8-unorm-srgb';
                  break;
                }
                case 89: {
                  enum64 = 'astc10x5-unorm';
                  break;
                }
                case 90: {
                  enum64 = 'astc10x5-unorm-srgb';
                  break;
                }
                case 91: {
                  enum64 = 'astc10x6-unorm';
                  break;
                }
                case 92: {
                  enum64 = 'astc10x6-unorm-srgb';
                  break;
                }
                case 93: {
                  enum64 = 'astc10x8-unorm';
                  break;
                }
                case 94: {
                  enum64 = 'astc10x8-unorm-srgb';
                  break;
                }
                case 95: {
                  enum64 = 'astc10x10-unorm';
                  break;
                }
                case 96: {
                  enum64 = 'astc10x10-unorm-srgb';
                  break;
                }
                case 97: {
                  enum64 = 'astc12x10-unorm';
                  break;
                }
                case 98: {
                  enum64 = 'astc12x10-unorm-srgb';
                  break;
                }
                case 99: {
                  enum64 = 'astc12x12-unorm';
                  break;
                }
                case 100: {
                  enum64 = 'astc12x12-unorm-srgb';
                  break;
                }
                default: {
                  throw new TypeError('invalid discriminant specified for GpuTextureFormat');
                }
              }
              let variant77;
              switch (dataView(memory0).getUint8(base + 2, true)) {
                case 0: {
                  variant77 = undefined;
                  break;
                }
                case 1: {
                  let variant66;
                  switch (dataView(memory0).getUint8(base + 3, true)) {
                    case 0: {
                      variant66 = undefined;
                      break;
                    }
                    case 1: {
                      let enum65;
                      switch (dataView(memory0).getUint8(base + 4, true)) {
                        case 0: {
                          enum65 = 'add';
                          break;
                        }
                        case 1: {
                          enum65 = 'subtract';
                          break;
                        }
                        case 2: {
                          enum65 = 'reverse-subtract';
                          break;
                        }
                        case 3: {
                          enum65 = 'min';
                          break;
                        }
                        case 4: {
                          enum65 = 'max';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendOperation');
                        }
                      }
                      variant66 = enum65;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  let variant68;
                  switch (dataView(memory0).getUint8(base + 5, true)) {
                    case 0: {
                      variant68 = undefined;
                      break;
                    }
                    case 1: {
                      let enum67;
                      switch (dataView(memory0).getUint8(base + 6, true)) {
                        case 0: {
                          enum67 = 'zero';
                          break;
                        }
                        case 1: {
                          enum67 = 'one';
                          break;
                        }
                        case 2: {
                          enum67 = 'src';
                          break;
                        }
                        case 3: {
                          enum67 = 'one-minus-src';
                          break;
                        }
                        case 4: {
                          enum67 = 'src-alpha';
                          break;
                        }
                        case 5: {
                          enum67 = 'one-minus-src-alpha';
                          break;
                        }
                        case 6: {
                          enum67 = 'dst';
                          break;
                        }
                        case 7: {
                          enum67 = 'one-minus-dst';
                          break;
                        }
                        case 8: {
                          enum67 = 'dst-alpha';
                          break;
                        }
                        case 9: {
                          enum67 = 'one-minus-dst-alpha';
                          break;
                        }
                        case 10: {
                          enum67 = 'src-alpha-saturated';
                          break;
                        }
                        case 11: {
                          enum67 = 'constant';
                          break;
                        }
                        case 12: {
                          enum67 = 'one-minus-constant';
                          break;
                        }
                        case 13: {
                          enum67 = 'src1';
                          break;
                        }
                        case 14: {
                          enum67 = 'one-minus-src1';
                          break;
                        }
                        case 15: {
                          enum67 = 'src1-alpha';
                          break;
                        }
                        case 16: {
                          enum67 = 'one-minus-src1-alpha';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendFactor');
                        }
                      }
                      variant68 = enum67;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  let variant70;
                  switch (dataView(memory0).getUint8(base + 7, true)) {
                    case 0: {
                      variant70 = undefined;
                      break;
                    }
                    case 1: {
                      let enum69;
                      switch (dataView(memory0).getUint8(base + 8, true)) {
                        case 0: {
                          enum69 = 'zero';
                          break;
                        }
                        case 1: {
                          enum69 = 'one';
                          break;
                        }
                        case 2: {
                          enum69 = 'src';
                          break;
                        }
                        case 3: {
                          enum69 = 'one-minus-src';
                          break;
                        }
                        case 4: {
                          enum69 = 'src-alpha';
                          break;
                        }
                        case 5: {
                          enum69 = 'one-minus-src-alpha';
                          break;
                        }
                        case 6: {
                          enum69 = 'dst';
                          break;
                        }
                        case 7: {
                          enum69 = 'one-minus-dst';
                          break;
                        }
                        case 8: {
                          enum69 = 'dst-alpha';
                          break;
                        }
                        case 9: {
                          enum69 = 'one-minus-dst-alpha';
                          break;
                        }
                        case 10: {
                          enum69 = 'src-alpha-saturated';
                          break;
                        }
                        case 11: {
                          enum69 = 'constant';
                          break;
                        }
                        case 12: {
                          enum69 = 'one-minus-constant';
                          break;
                        }
                        case 13: {
                          enum69 = 'src1';
                          break;
                        }
                        case 14: {
                          enum69 = 'one-minus-src1';
                          break;
                        }
                        case 15: {
                          enum69 = 'src1-alpha';
                          break;
                        }
                        case 16: {
                          enum69 = 'one-minus-src1-alpha';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendFactor');
                        }
                      }
                      variant70 = enum69;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  let variant72;
                  switch (dataView(memory0).getUint8(base + 9, true)) {
                    case 0: {
                      variant72 = undefined;
                      break;
                    }
                    case 1: {
                      let enum71;
                      switch (dataView(memory0).getUint8(base + 10, true)) {
                        case 0: {
                          enum71 = 'add';
                          break;
                        }
                        case 1: {
                          enum71 = 'subtract';
                          break;
                        }
                        case 2: {
                          enum71 = 'reverse-subtract';
                          break;
                        }
                        case 3: {
                          enum71 = 'min';
                          break;
                        }
                        case 4: {
                          enum71 = 'max';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendOperation');
                        }
                      }
                      variant72 = enum71;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  let variant74;
                  switch (dataView(memory0).getUint8(base + 11, true)) {
                    case 0: {
                      variant74 = undefined;
                      break;
                    }
                    case 1: {
                      let enum73;
                      switch (dataView(memory0).getUint8(base + 12, true)) {
                        case 0: {
                          enum73 = 'zero';
                          break;
                        }
                        case 1: {
                          enum73 = 'one';
                          break;
                        }
                        case 2: {
                          enum73 = 'src';
                          break;
                        }
                        case 3: {
                          enum73 = 'one-minus-src';
                          break;
                        }
                        case 4: {
                          enum73 = 'src-alpha';
                          break;
                        }
                        case 5: {
                          enum73 = 'one-minus-src-alpha';
                          break;
                        }
                        case 6: {
                          enum73 = 'dst';
                          break;
                        }
                        case 7: {
                          enum73 = 'one-minus-dst';
                          break;
                        }
                        case 8: {
                          enum73 = 'dst-alpha';
                          break;
                        }
                        case 9: {
                          enum73 = 'one-minus-dst-alpha';
                          break;
                        }
                        case 10: {
                          enum73 = 'src-alpha-saturated';
                          break;
                        }
                        case 11: {
                          enum73 = 'constant';
                          break;
                        }
                        case 12: {
                          enum73 = 'one-minus-constant';
                          break;
                        }
                        case 13: {
                          enum73 = 'src1';
                          break;
                        }
                        case 14: {
                          enum73 = 'one-minus-src1';
                          break;
                        }
                        case 15: {
                          enum73 = 'src1-alpha';
                          break;
                        }
                        case 16: {
                          enum73 = 'one-minus-src1-alpha';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendFactor');
                        }
                      }
                      variant74 = enum73;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  let variant76;
                  switch (dataView(memory0).getUint8(base + 13, true)) {
                    case 0: {
                      variant76 = undefined;
                      break;
                    }
                    case 1: {
                      let enum75;
                      switch (dataView(memory0).getUint8(base + 14, true)) {
                        case 0: {
                          enum75 = 'zero';
                          break;
                        }
                        case 1: {
                          enum75 = 'one';
                          break;
                        }
                        case 2: {
                          enum75 = 'src';
                          break;
                        }
                        case 3: {
                          enum75 = 'one-minus-src';
                          break;
                        }
                        case 4: {
                          enum75 = 'src-alpha';
                          break;
                        }
                        case 5: {
                          enum75 = 'one-minus-src-alpha';
                          break;
                        }
                        case 6: {
                          enum75 = 'dst';
                          break;
                        }
                        case 7: {
                          enum75 = 'one-minus-dst';
                          break;
                        }
                        case 8: {
                          enum75 = 'dst-alpha';
                          break;
                        }
                        case 9: {
                          enum75 = 'one-minus-dst-alpha';
                          break;
                        }
                        case 10: {
                          enum75 = 'src-alpha-saturated';
                          break;
                        }
                        case 11: {
                          enum75 = 'constant';
                          break;
                        }
                        case 12: {
                          enum75 = 'one-minus-constant';
                          break;
                        }
                        case 13: {
                          enum75 = 'src1';
                          break;
                        }
                        case 14: {
                          enum75 = 'one-minus-src1';
                          break;
                        }
                        case 15: {
                          enum75 = 'src1-alpha';
                          break;
                        }
                        case 16: {
                          enum75 = 'one-minus-src1-alpha';
                          break;
                        }
                        default: {
                          throw new TypeError('invalid discriminant specified for GpuBlendFactor');
                        }
                      }
                      variant76 = enum75;
                      break;
                    }
                    default: {
                      throw new TypeError('invalid variant discriminant for option');
                    }
                  }
                  variant77 = {
                    color: {
                      operation: variant66,
                      srcFactor: variant68,
                      dstFactor: variant70,
                    },
                    alpha: {
                      operation: variant72,
                      srcFactor: variant74,
                      dstFactor: variant76,
                    },
                  };
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant79;
              switch (dataView(memory0).getUint8(base + 15, true)) {
                case 0: {
                  variant79 = undefined;
                  break;
                }
                case 1: {
                  if ((dataView(memory0).getUint8(base + 16, true) & 4294967264) !== 0) {
                    throw new TypeError('flags have extraneous bits set');
                  }
                  var flags78 = {
                    red: Boolean(dataView(memory0).getUint8(base + 16, true) & 1),
                    green: Boolean(dataView(memory0).getUint8(base + 16, true) & 2),
                    blue: Boolean(dataView(memory0).getUint8(base + 16, true) & 4),
                    alpha: Boolean(dataView(memory0).getUint8(base + 16, true) & 8),
                    all: Boolean(dataView(memory0).getUint8(base + 16, true) & 16),
                  };
                  variant79 = flags78;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant80 = {
                format: enum64,
                blend: variant77,
                writeMask: variant79,
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          result81.push(variant80);
        }
        var handle83 = dataView(memory0).getInt32(arg0 + 156, true);
        
        var rep84 = handleTable12[(handle83 << 1) + 1] & ~T_FLAG;
        var rsc82 = captureTable12.get(rep84);
        if (!rsc82) {
          rsc82 = Object.create(GpuShaderModule.prototype);
          Object.defineProperty(rsc82, symbolRscHandle, { writable: true, value: handle83});
          Object.defineProperty(rsc82, symbolRscRep, { writable: true, value: rep84});
        }
        
        curResourceBorrows.push(rsc82);
        let variant86;
        switch (dataView(memory0).getUint8(arg0 + 160, true)) {
          case 0: {
            variant86 = undefined;
            break;
          }
          case 1: {
            var ptr85 = dataView(memory0).getUint32(arg0 + 164, true);
            var len85 = dataView(memory0).getUint32(arg0 + 168, true);
            var result85 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr85, len85));
            variant86 = result85;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant90;
        switch (dataView(memory0).getUint8(arg0 + 172, true)) {
          case 0: {
            variant90 = undefined;
            break;
          }
          case 1: {
            var handle88 = dataView(memory0).getInt32(arg0 + 176, true);
            
            var rep89 = handleTable13[(handle88 << 1) + 1] & ~T_FLAG;
            var rsc87 = captureTable13.get(rep89);
            if (!rsc87) {
              rsc87 = Object.create(RecordGpuPipelineConstantValue.prototype);
              Object.defineProperty(rsc87, symbolRscHandle, { writable: true, value: handle88});
              Object.defineProperty(rsc87, symbolRscRep, { writable: true, value: rep89});
            }
            
            else {
              captureTable13.delete(rep89);
            }
            rscTableRemove(handleTable13, handle88);
            variant90 = rsc87;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant91 = {
          targets: result81,
          module: rsc82,
          entryPoint: variant86,
          constants: variant90,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant95;
    switch (dataView(memory0).getUint8(arg0 + 180, true)) {
      case 0: {
        var handle93 = dataView(memory0).getInt32(arg0 + 184, true);
        
        var rep94 = handleTable11[(handle93 << 1) + 1] & ~T_FLAG;
        var rsc92 = captureTable11.get(rep94);
        if (!rsc92) {
          rsc92 = Object.create(GpuPipelineLayout.prototype);
          Object.defineProperty(rsc92, symbolRscHandle, { writable: true, value: handle93});
          Object.defineProperty(rsc92, symbolRscRep, { writable: true, value: rep94});
        }
        
        curResourceBorrows.push(rsc92);
        variant95= {
          tag: 'specific',
          val: rsc92
        };
        break;
      }
      case 1: {
        variant95= {
          tag: 'auto',
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for GpuLayoutMode');
      }
    }
    let variant97;
    switch (dataView(memory0).getUint8(arg0 + 188, true)) {
      case 0: {
        variant97 = undefined;
        break;
      }
      case 1: {
        var ptr96 = dataView(memory0).getUint32(arg0 + 192, true);
        var len96 = dataView(memory0).getUint32(arg0 + 196, true);
        var result96 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr96, len96));
        variant97 = result96;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-render-pipeline"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'createRenderPipeline',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.createRenderPipeline({
          vertex: {
            buffers: variant9,
            module: rsc10,
            entryPoint: variant14,
            constants: variant18,
          },
          primitive: variant29,
          depthStencil: variant58,
          multisample: variant63,
          fragment: variant91,
          layout: variant95,
          label: variant97,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuRenderPipeline)) {
      throw new TypeError('Resource error: Not a valid \"GpuRenderPipeline\" resource.');
    }
    var handle98 = ret[symbolRscHandle];
    if (!handle98) {
      const rep = ret[symbolRscRep] || ++captureCnt14;
      captureTable14.set(rep, ret);
      handle98 = rscTableCreateOwn(handleTable14, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-render-pipeline"][Instruction::Return]', {
      funcName: '[method]gpu-device.create-render-pipeline',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle98]);
    task.exit();
    return handle98;
  }
  _trampoline66.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#createRenderPipeline';
  
  const _trampoline67 = function(arg0, arg1, arg2, arg3, arg4) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant5;
    switch (arg1) {
      case 0: {
        variant5 = undefined;
        break;
      }
      case 1: {
        let variant4;
        switch (arg2) {
          case 0: {
            variant4 = undefined;
            break;
          }
          case 1: {
            var ptr3 = arg3;
            var len3 = arg4;
            var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
            variant4 = result3;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant5 = {
          label: variant4,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-command-encoder"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'createCommandEncoder',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.createCommandEncoder(variant5),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuCommandEncoder)) {
      throw new TypeError('Resource error: Not a valid \"GpuCommandEncoder\" resource.');
    }
    var handle6 = ret[symbolRscHandle];
    if (!handle6) {
      const rep = ret[symbolRscRep] || ++captureCnt4;
      captureTable4.set(rep, ret);
      handle6 = rscTableCreateOwn(handleTable4, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-device.create-command-encoder"][Instruction::Return]', {
      funcName: '[method]gpu-device.create-command-encoder',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle6]);
    task.exit();
    return handle6;
  }
  _trampoline67.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#createCommandEncoder';
  
  const _trampoline68 = function(arg0, arg1, arg2) {
    var handle1 = arg0;
    
    var rep2 = handleTable9[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable9.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuQueue.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var len6 = arg2;
    var base6 = arg1;
    if (base6 % 4 !== 0) throw new TypeError(`list pointer [${base6}] is not aligned to 4`);
    var result6 = [];
    for (let i = 0; i < len6; i++) {
      const base = base6 + i * 4;
      var handle4 = dataView(memory0).getInt32(base + 0, true);
      
      var rep5 = handleTable8[(handle4 << 1) + 1] & ~T_FLAG;
      var rsc3 = captureTable8.get(rep5);
      if (!rsc3) {
        rsc3 = Object.create(GpuCommandBuffer.prototype);
        Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
        Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
      }
      
      curResourceBorrows.push(rsc3);
      result6.push(rsc3);
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-queue.submit"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'submit',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.submit(result6),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-queue.submit"][Instruction::Return]', {
      funcName: '[method]gpu-queue.submit',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline68.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#submit';
  
  const _trampoline69 = function(arg0) {
    var handle1 = dataView(memory0).getInt32(arg0 + 0, true);
    
    var rep2 = handleTable15[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable15.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(GpuTexture.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    let variant19;
    switch (dataView(memory0).getUint8(arg0 + 4, true)) {
      case 0: {
        variant19 = undefined;
        break;
      }
      case 1: {
        let variant4;
        switch (dataView(memory0).getUint8(arg0 + 8, true)) {
          case 0: {
            variant4 = undefined;
            break;
          }
          case 1: {
            let enum3;
            switch (dataView(memory0).getUint8(arg0 + 9, true)) {
              case 0: {
                enum3 = 'r8unorm';
                break;
              }
              case 1: {
                enum3 = 'r8snorm';
                break;
              }
              case 2: {
                enum3 = 'r8uint';
                break;
              }
              case 3: {
                enum3 = 'r8sint';
                break;
              }
              case 4: {
                enum3 = 'r16unorm';
                break;
              }
              case 5: {
                enum3 = 'r16snorm';
                break;
              }
              case 6: {
                enum3 = 'r16uint';
                break;
              }
              case 7: {
                enum3 = 'r16sint';
                break;
              }
              case 8: {
                enum3 = 'r16float';
                break;
              }
              case 9: {
                enum3 = 'rg8unorm';
                break;
              }
              case 10: {
                enum3 = 'rg8snorm';
                break;
              }
              case 11: {
                enum3 = 'rg8uint';
                break;
              }
              case 12: {
                enum3 = 'rg8sint';
                break;
              }
              case 13: {
                enum3 = 'r32uint';
                break;
              }
              case 14: {
                enum3 = 'r32sint';
                break;
              }
              case 15: {
                enum3 = 'r32float';
                break;
              }
              case 16: {
                enum3 = 'rg16unorm';
                break;
              }
              case 17: {
                enum3 = 'rg16snorm';
                break;
              }
              case 18: {
                enum3 = 'rg16uint';
                break;
              }
              case 19: {
                enum3 = 'rg16sint';
                break;
              }
              case 20: {
                enum3 = 'rg16float';
                break;
              }
              case 21: {
                enum3 = 'rgba8unorm';
                break;
              }
              case 22: {
                enum3 = 'rgba8unorm-srgb';
                break;
              }
              case 23: {
                enum3 = 'rgba8snorm';
                break;
              }
              case 24: {
                enum3 = 'rgba8uint';
                break;
              }
              case 25: {
                enum3 = 'rgba8sint';
                break;
              }
              case 26: {
                enum3 = 'bgra8unorm';
                break;
              }
              case 27: {
                enum3 = 'bgra8unorm-srgb';
                break;
              }
              case 28: {
                enum3 = 'rgb9e5ufloat';
                break;
              }
              case 29: {
                enum3 = 'rgb10a2uint';
                break;
              }
              case 30: {
                enum3 = 'rgb10a2unorm';
                break;
              }
              case 31: {
                enum3 = 'rg11b10ufloat';
                break;
              }
              case 32: {
                enum3 = 'rg32uint';
                break;
              }
              case 33: {
                enum3 = 'rg32sint';
                break;
              }
              case 34: {
                enum3 = 'rg32float';
                break;
              }
              case 35: {
                enum3 = 'rgba16unorm';
                break;
              }
              case 36: {
                enum3 = 'rgba16snorm';
                break;
              }
              case 37: {
                enum3 = 'rgba16uint';
                break;
              }
              case 38: {
                enum3 = 'rgba16sint';
                break;
              }
              case 39: {
                enum3 = 'rgba16float';
                break;
              }
              case 40: {
                enum3 = 'rgba32uint';
                break;
              }
              case 41: {
                enum3 = 'rgba32sint';
                break;
              }
              case 42: {
                enum3 = 'rgba32float';
                break;
              }
              case 43: {
                enum3 = 'stencil8';
                break;
              }
              case 44: {
                enum3 = 'depth16unorm';
                break;
              }
              case 45: {
                enum3 = 'depth24plus';
                break;
              }
              case 46: {
                enum3 = 'depth24plus-stencil8';
                break;
              }
              case 47: {
                enum3 = 'depth32float';
                break;
              }
              case 48: {
                enum3 = 'depth32float-stencil8';
                break;
              }
              case 49: {
                enum3 = 'bc1-rgba-unorm';
                break;
              }
              case 50: {
                enum3 = 'bc1-rgba-unorm-srgb';
                break;
              }
              case 51: {
                enum3 = 'bc2-rgba-unorm';
                break;
              }
              case 52: {
                enum3 = 'bc2-rgba-unorm-srgb';
                break;
              }
              case 53: {
                enum3 = 'bc3-rgba-unorm';
                break;
              }
              case 54: {
                enum3 = 'bc3-rgba-unorm-srgb';
                break;
              }
              case 55: {
                enum3 = 'bc4-r-unorm';
                break;
              }
              case 56: {
                enum3 = 'bc4-r-snorm';
                break;
              }
              case 57: {
                enum3 = 'bc5-rg-unorm';
                break;
              }
              case 58: {
                enum3 = 'bc5-rg-snorm';
                break;
              }
              case 59: {
                enum3 = 'bc6h-rgb-ufloat';
                break;
              }
              case 60: {
                enum3 = 'bc6h-rgb-float';
                break;
              }
              case 61: {
                enum3 = 'bc7-rgba-unorm';
                break;
              }
              case 62: {
                enum3 = 'bc7-rgba-unorm-srgb';
                break;
              }
              case 63: {
                enum3 = 'etc2-rgb8unorm';
                break;
              }
              case 64: {
                enum3 = 'etc2-rgb8unorm-srgb';
                break;
              }
              case 65: {
                enum3 = 'etc2-rgb8a1unorm';
                break;
              }
              case 66: {
                enum3 = 'etc2-rgb8a1unorm-srgb';
                break;
              }
              case 67: {
                enum3 = 'etc2-rgba8unorm';
                break;
              }
              case 68: {
                enum3 = 'etc2-rgba8unorm-srgb';
                break;
              }
              case 69: {
                enum3 = 'eac-r11unorm';
                break;
              }
              case 70: {
                enum3 = 'eac-r11snorm';
                break;
              }
              case 71: {
                enum3 = 'eac-rg11unorm';
                break;
              }
              case 72: {
                enum3 = 'eac-rg11snorm';
                break;
              }
              case 73: {
                enum3 = 'astc4x4-unorm';
                break;
              }
              case 74: {
                enum3 = 'astc4x4-unorm-srgb';
                break;
              }
              case 75: {
                enum3 = 'astc5x4-unorm';
                break;
              }
              case 76: {
                enum3 = 'astc5x4-unorm-srgb';
                break;
              }
              case 77: {
                enum3 = 'astc5x5-unorm';
                break;
              }
              case 78: {
                enum3 = 'astc5x5-unorm-srgb';
                break;
              }
              case 79: {
                enum3 = 'astc6x5-unorm';
                break;
              }
              case 80: {
                enum3 = 'astc6x5-unorm-srgb';
                break;
              }
              case 81: {
                enum3 = 'astc6x6-unorm';
                break;
              }
              case 82: {
                enum3 = 'astc6x6-unorm-srgb';
                break;
              }
              case 83: {
                enum3 = 'astc8x5-unorm';
                break;
              }
              case 84: {
                enum3 = 'astc8x5-unorm-srgb';
                break;
              }
              case 85: {
                enum3 = 'astc8x6-unorm';
                break;
              }
              case 86: {
                enum3 = 'astc8x6-unorm-srgb';
                break;
              }
              case 87: {
                enum3 = 'astc8x8-unorm';
                break;
              }
              case 88: {
                enum3 = 'astc8x8-unorm-srgb';
                break;
              }
              case 89: {
                enum3 = 'astc10x5-unorm';
                break;
              }
              case 90: {
                enum3 = 'astc10x5-unorm-srgb';
                break;
              }
              case 91: {
                enum3 = 'astc10x6-unorm';
                break;
              }
              case 92: {
                enum3 = 'astc10x6-unorm-srgb';
                break;
              }
              case 93: {
                enum3 = 'astc10x8-unorm';
                break;
              }
              case 94: {
                enum3 = 'astc10x8-unorm-srgb';
                break;
              }
              case 95: {
                enum3 = 'astc10x10-unorm';
                break;
              }
              case 96: {
                enum3 = 'astc10x10-unorm-srgb';
                break;
              }
              case 97: {
                enum3 = 'astc12x10-unorm';
                break;
              }
              case 98: {
                enum3 = 'astc12x10-unorm-srgb';
                break;
              }
              case 99: {
                enum3 = 'astc12x12-unorm';
                break;
              }
              case 100: {
                enum3 = 'astc12x12-unorm-srgb';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuTextureFormat');
              }
            }
            variant4 = enum3;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant6;
        switch (dataView(memory0).getUint8(arg0 + 10, true)) {
          case 0: {
            variant6 = undefined;
            break;
          }
          case 1: {
            let enum5;
            switch (dataView(memory0).getUint8(arg0 + 11, true)) {
              case 0: {
                enum5 = 'd1';
                break;
              }
              case 1: {
                enum5 = 'd2';
                break;
              }
              case 2: {
                enum5 = 'd2-array';
                break;
              }
              case 3: {
                enum5 = 'cube';
                break;
              }
              case 4: {
                enum5 = 'cube-array';
                break;
              }
              case 5: {
                enum5 = 'd3';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuTextureViewDimension');
              }
            }
            variant6 = enum5;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant8;
        switch (dataView(memory0).getUint8(arg0 + 12, true)) {
          case 0: {
            variant8 = undefined;
            break;
          }
          case 1: {
            if ((dataView(memory0).getUint8(arg0 + 13, true) & 4294967232) !== 0) {
              throw new TypeError('flags have extraneous bits set');
            }
            var flags7 = {
              copySrc: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 1),
              copyDst: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 2),
              textureBinding: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 4),
              storageBinding: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 8),
              renderAttachment: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 16),
              transientAttachment: Boolean(dataView(memory0).getUint8(arg0 + 13, true) & 32),
            };
            variant8 = flags7;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant10;
        switch (dataView(memory0).getUint8(arg0 + 14, true)) {
          case 0: {
            variant10 = undefined;
            break;
          }
          case 1: {
            let enum9;
            switch (dataView(memory0).getUint8(arg0 + 15, true)) {
              case 0: {
                enum9 = 'all';
                break;
              }
              case 1: {
                enum9 = 'stencil-only';
                break;
              }
              case 2: {
                enum9 = 'depth-only';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuTextureAspect');
              }
            }
            variant10 = enum9;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant11;
        switch (dataView(memory0).getUint8(arg0 + 16, true)) {
          case 0: {
            variant11 = undefined;
            break;
          }
          case 1: {
            variant11 = dataView(memory0).getInt32(arg0 + 20, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant12;
        switch (dataView(memory0).getUint8(arg0 + 24, true)) {
          case 0: {
            variant12 = undefined;
            break;
          }
          case 1: {
            variant12 = dataView(memory0).getInt32(arg0 + 28, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant13;
        switch (dataView(memory0).getUint8(arg0 + 32, true)) {
          case 0: {
            variant13 = undefined;
            break;
          }
          case 1: {
            variant13 = dataView(memory0).getInt32(arg0 + 36, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant14;
        switch (dataView(memory0).getUint8(arg0 + 40, true)) {
          case 0: {
            variant14 = undefined;
            break;
          }
          case 1: {
            variant14 = dataView(memory0).getInt32(arg0 + 44, true) >>> 0;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant16;
        switch (dataView(memory0).getUint8(arg0 + 48, true)) {
          case 0: {
            variant16 = undefined;
            break;
          }
          case 1: {
            var ptr15 = dataView(memory0).getUint32(arg0 + 52, true);
            var len15 = dataView(memory0).getUint32(arg0 + 56, true);
            var result15 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr15, len15));
            variant16 = result15;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        let variant18;
        switch (dataView(memory0).getUint8(arg0 + 60, true)) {
          case 0: {
            variant18 = undefined;
            break;
          }
          case 1: {
            var ptr17 = dataView(memory0).getUint32(arg0 + 64, true);
            var len17 = dataView(memory0).getUint32(arg0 + 68, true);
            var result17 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr17, len17));
            variant18 = result17;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant19 = {
          format: variant4,
          dimension: variant6,
          usage: variant8,
          aspect: variant10,
          baseMipLevel: variant11,
          mipLevelCount: variant12,
          baseArrayLayer: variant13,
          arrayLayerCount: variant14,
          swizzle: variant16,
          label: variant18,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-texture.create-view"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'createView',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.createView(variant19),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    
    if (!(ret instanceof GpuTextureView)) {
      throw new TypeError('Resource error: Not a valid \"GpuTextureView\" resource.');
    }
    var handle20 = ret[symbolRscHandle];
    if (!handle20) {
      const rep = ret[symbolRscRep] || ++captureCnt5;
      captureTable5.set(rep, ret);
      handle20 = rscTableCreateOwn(handleTable5, rep);
    }
    
    _debugLog('[iface="wasi:webgpu/webgpu@0.3.0-rc.2", function="[method]gpu-texture.create-view"][Instruction::Return]', {
      funcName: '[method]gpu-texture.create-view',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle20]);
    task.exit();
    return handle20;
  }
  _trampoline69.fnName = 'wasi:webgpu/webgpu@0.3.0-rc.2#createView';
  
  const _trampoline78 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11, arg12, arg13, arg14) {
    var handle1 = arg0;
    
    var rep2 = handleTable17[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable17.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Context.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    var handle4 = arg1;
    
    var rep5 = handleTable3[(handle4 << 1) + 1] & ~T_FLAG;
    var rsc3 = captureTable3.get(rep5);
    if (!rsc3) {
      rsc3 = Object.create(GpuDevice.prototype);
      Object.defineProperty(rsc3, symbolRscHandle, { writable: true, value: handle4});
      Object.defineProperty(rsc3, symbolRscRep, { writable: true, value: rep5});
    }
    
    curResourceBorrows.push(rsc3);
    let enum6;
    switch (arg2) {
      case 0: {
        enum6 = 'r8unorm';
        break;
      }
      case 1: {
        enum6 = 'r8snorm';
        break;
      }
      case 2: {
        enum6 = 'r8uint';
        break;
      }
      case 3: {
        enum6 = 'r8sint';
        break;
      }
      case 4: {
        enum6 = 'r16unorm';
        break;
      }
      case 5: {
        enum6 = 'r16snorm';
        break;
      }
      case 6: {
        enum6 = 'r16uint';
        break;
      }
      case 7: {
        enum6 = 'r16sint';
        break;
      }
      case 8: {
        enum6 = 'r16float';
        break;
      }
      case 9: {
        enum6 = 'rg8unorm';
        break;
      }
      case 10: {
        enum6 = 'rg8snorm';
        break;
      }
      case 11: {
        enum6 = 'rg8uint';
        break;
      }
      case 12: {
        enum6 = 'rg8sint';
        break;
      }
      case 13: {
        enum6 = 'r32uint';
        break;
      }
      case 14: {
        enum6 = 'r32sint';
        break;
      }
      case 15: {
        enum6 = 'r32float';
        break;
      }
      case 16: {
        enum6 = 'rg16unorm';
        break;
      }
      case 17: {
        enum6 = 'rg16snorm';
        break;
      }
      case 18: {
        enum6 = 'rg16uint';
        break;
      }
      case 19: {
        enum6 = 'rg16sint';
        break;
      }
      case 20: {
        enum6 = 'rg16float';
        break;
      }
      case 21: {
        enum6 = 'rgba8unorm';
        break;
      }
      case 22: {
        enum6 = 'rgba8unorm-srgb';
        break;
      }
      case 23: {
        enum6 = 'rgba8snorm';
        break;
      }
      case 24: {
        enum6 = 'rgba8uint';
        break;
      }
      case 25: {
        enum6 = 'rgba8sint';
        break;
      }
      case 26: {
        enum6 = 'bgra8unorm';
        break;
      }
      case 27: {
        enum6 = 'bgra8unorm-srgb';
        break;
      }
      case 28: {
        enum6 = 'rgb9e5ufloat';
        break;
      }
      case 29: {
        enum6 = 'rgb10a2uint';
        break;
      }
      case 30: {
        enum6 = 'rgb10a2unorm';
        break;
      }
      case 31: {
        enum6 = 'rg11b10ufloat';
        break;
      }
      case 32: {
        enum6 = 'rg32uint';
        break;
      }
      case 33: {
        enum6 = 'rg32sint';
        break;
      }
      case 34: {
        enum6 = 'rg32float';
        break;
      }
      case 35: {
        enum6 = 'rgba16unorm';
        break;
      }
      case 36: {
        enum6 = 'rgba16snorm';
        break;
      }
      case 37: {
        enum6 = 'rgba16uint';
        break;
      }
      case 38: {
        enum6 = 'rgba16sint';
        break;
      }
      case 39: {
        enum6 = 'rgba16float';
        break;
      }
      case 40: {
        enum6 = 'rgba32uint';
        break;
      }
      case 41: {
        enum6 = 'rgba32sint';
        break;
      }
      case 42: {
        enum6 = 'rgba32float';
        break;
      }
      case 43: {
        enum6 = 'stencil8';
        break;
      }
      case 44: {
        enum6 = 'depth16unorm';
        break;
      }
      case 45: {
        enum6 = 'depth24plus';
        break;
      }
      case 46: {
        enum6 = 'depth24plus-stencil8';
        break;
      }
      case 47: {
        enum6 = 'depth32float';
        break;
      }
      case 48: {
        enum6 = 'depth32float-stencil8';
        break;
      }
      case 49: {
        enum6 = 'bc1-rgba-unorm';
        break;
      }
      case 50: {
        enum6 = 'bc1-rgba-unorm-srgb';
        break;
      }
      case 51: {
        enum6 = 'bc2-rgba-unorm';
        break;
      }
      case 52: {
        enum6 = 'bc2-rgba-unorm-srgb';
        break;
      }
      case 53: {
        enum6 = 'bc3-rgba-unorm';
        break;
      }
      case 54: {
        enum6 = 'bc3-rgba-unorm-srgb';
        break;
      }
      case 55: {
        enum6 = 'bc4-r-unorm';
        break;
      }
      case 56: {
        enum6 = 'bc4-r-snorm';
        break;
      }
      case 57: {
        enum6 = 'bc5-rg-unorm';
        break;
      }
      case 58: {
        enum6 = 'bc5-rg-snorm';
        break;
      }
      case 59: {
        enum6 = 'bc6h-rgb-ufloat';
        break;
      }
      case 60: {
        enum6 = 'bc6h-rgb-float';
        break;
      }
      case 61: {
        enum6 = 'bc7-rgba-unorm';
        break;
      }
      case 62: {
        enum6 = 'bc7-rgba-unorm-srgb';
        break;
      }
      case 63: {
        enum6 = 'etc2-rgb8unorm';
        break;
      }
      case 64: {
        enum6 = 'etc2-rgb8unorm-srgb';
        break;
      }
      case 65: {
        enum6 = 'etc2-rgb8a1unorm';
        break;
      }
      case 66: {
        enum6 = 'etc2-rgb8a1unorm-srgb';
        break;
      }
      case 67: {
        enum6 = 'etc2-rgba8unorm';
        break;
      }
      case 68: {
        enum6 = 'etc2-rgba8unorm-srgb';
        break;
      }
      case 69: {
        enum6 = 'eac-r11unorm';
        break;
      }
      case 70: {
        enum6 = 'eac-r11snorm';
        break;
      }
      case 71: {
        enum6 = 'eac-rg11unorm';
        break;
      }
      case 72: {
        enum6 = 'eac-rg11snorm';
        break;
      }
      case 73: {
        enum6 = 'astc4x4-unorm';
        break;
      }
      case 74: {
        enum6 = 'astc4x4-unorm-srgb';
        break;
      }
      case 75: {
        enum6 = 'astc5x4-unorm';
        break;
      }
      case 76: {
        enum6 = 'astc5x4-unorm-srgb';
        break;
      }
      case 77: {
        enum6 = 'astc5x5-unorm';
        break;
      }
      case 78: {
        enum6 = 'astc5x5-unorm-srgb';
        break;
      }
      case 79: {
        enum6 = 'astc6x5-unorm';
        break;
      }
      case 80: {
        enum6 = 'astc6x5-unorm-srgb';
        break;
      }
      case 81: {
        enum6 = 'astc6x6-unorm';
        break;
      }
      case 82: {
        enum6 = 'astc6x6-unorm-srgb';
        break;
      }
      case 83: {
        enum6 = 'astc8x5-unorm';
        break;
      }
      case 84: {
        enum6 = 'astc8x5-unorm-srgb';
        break;
      }
      case 85: {
        enum6 = 'astc8x6-unorm';
        break;
      }
      case 86: {
        enum6 = 'astc8x6-unorm-srgb';
        break;
      }
      case 87: {
        enum6 = 'astc8x8-unorm';
        break;
      }
      case 88: {
        enum6 = 'astc8x8-unorm-srgb';
        break;
      }
      case 89: {
        enum6 = 'astc10x5-unorm';
        break;
      }
      case 90: {
        enum6 = 'astc10x5-unorm-srgb';
        break;
      }
      case 91: {
        enum6 = 'astc10x6-unorm';
        break;
      }
      case 92: {
        enum6 = 'astc10x6-unorm-srgb';
        break;
      }
      case 93: {
        enum6 = 'astc10x8-unorm';
        break;
      }
      case 94: {
        enum6 = 'astc10x8-unorm-srgb';
        break;
      }
      case 95: {
        enum6 = 'astc10x10-unorm';
        break;
      }
      case 96: {
        enum6 = 'astc10x10-unorm-srgb';
        break;
      }
      case 97: {
        enum6 = 'astc12x10-unorm';
        break;
      }
      case 98: {
        enum6 = 'astc12x10-unorm-srgb';
        break;
      }
      case 99: {
        enum6 = 'astc12x12-unorm';
        break;
      }
      case 100: {
        enum6 = 'astc12x12-unorm-srgb';
        break;
      }
      default: {
        throw new TypeError('invalid discriminant specified for GpuTextureFormat');
      }
    }
    let variant8;
    switch (arg3) {
      case 0: {
        variant8 = undefined;
        break;
      }
      case 1: {
        if ((arg4 & 4294967232) !== 0) {
          throw new TypeError('flags have extraneous bits set');
        }
        var flags7 = {
          copySrc: Boolean(arg4 & 1),
          copyDst: Boolean(arg4 & 2),
          textureBinding: Boolean(arg4 & 4),
          storageBinding: Boolean(arg4 & 8),
          renderAttachment: Boolean(arg4 & 16),
          transientAttachment: Boolean(arg4 & 32),
        };
        variant8 = flags7;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant11;
    switch (arg5) {
      case 0: {
        variant11 = undefined;
        break;
      }
      case 1: {
        var len10 = arg7;
        var base10 = arg6;
        if (base10 % 1 !== 0) throw new TypeError(`list pointer [${base10}] is not aligned to 1`);
        var result10 = [];
        for (let i = 0; i < len10; i++) {
          const base = base10 + i * 1;
          let enum9;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              enum9 = 'r8unorm';
              break;
            }
            case 1: {
              enum9 = 'r8snorm';
              break;
            }
            case 2: {
              enum9 = 'r8uint';
              break;
            }
            case 3: {
              enum9 = 'r8sint';
              break;
            }
            case 4: {
              enum9 = 'r16unorm';
              break;
            }
            case 5: {
              enum9 = 'r16snorm';
              break;
            }
            case 6: {
              enum9 = 'r16uint';
              break;
            }
            case 7: {
              enum9 = 'r16sint';
              break;
            }
            case 8: {
              enum9 = 'r16float';
              break;
            }
            case 9: {
              enum9 = 'rg8unorm';
              break;
            }
            case 10: {
              enum9 = 'rg8snorm';
              break;
            }
            case 11: {
              enum9 = 'rg8uint';
              break;
            }
            case 12: {
              enum9 = 'rg8sint';
              break;
            }
            case 13: {
              enum9 = 'r32uint';
              break;
            }
            case 14: {
              enum9 = 'r32sint';
              break;
            }
            case 15: {
              enum9 = 'r32float';
              break;
            }
            case 16: {
              enum9 = 'rg16unorm';
              break;
            }
            case 17: {
              enum9 = 'rg16snorm';
              break;
            }
            case 18: {
              enum9 = 'rg16uint';
              break;
            }
            case 19: {
              enum9 = 'rg16sint';
              break;
            }
            case 20: {
              enum9 = 'rg16float';
              break;
            }
            case 21: {
              enum9 = 'rgba8unorm';
              break;
            }
            case 22: {
              enum9 = 'rgba8unorm-srgb';
              break;
            }
            case 23: {
              enum9 = 'rgba8snorm';
              break;
            }
            case 24: {
              enum9 = 'rgba8uint';
              break;
            }
            case 25: {
              enum9 = 'rgba8sint';
              break;
            }
            case 26: {
              enum9 = 'bgra8unorm';
              break;
            }
            case 27: {
              enum9 = 'bgra8unorm-srgb';
              break;
            }
            case 28: {
              enum9 = 'rgb9e5ufloat';
              break;
            }
            case 29: {
              enum9 = 'rgb10a2uint';
              break;
            }
            case 30: {
              enum9 = 'rgb10a2unorm';
              break;
            }
            case 31: {
              enum9 = 'rg11b10ufloat';
              break;
            }
            case 32: {
              enum9 = 'rg32uint';
              break;
            }
            case 33: {
              enum9 = 'rg32sint';
              break;
            }
            case 34: {
              enum9 = 'rg32float';
              break;
            }
            case 35: {
              enum9 = 'rgba16unorm';
              break;
            }
            case 36: {
              enum9 = 'rgba16snorm';
              break;
            }
            case 37: {
              enum9 = 'rgba16uint';
              break;
            }
            case 38: {
              enum9 = 'rgba16sint';
              break;
            }
            case 39: {
              enum9 = 'rgba16float';
              break;
            }
            case 40: {
              enum9 = 'rgba32uint';
              break;
            }
            case 41: {
              enum9 = 'rgba32sint';
              break;
            }
            case 42: {
              enum9 = 'rgba32float';
              break;
            }
            case 43: {
              enum9 = 'stencil8';
              break;
            }
            case 44: {
              enum9 = 'depth16unorm';
              break;
            }
            case 45: {
              enum9 = 'depth24plus';
              break;
            }
            case 46: {
              enum9 = 'depth24plus-stencil8';
              break;
            }
            case 47: {
              enum9 = 'depth32float';
              break;
            }
            case 48: {
              enum9 = 'depth32float-stencil8';
              break;
            }
            case 49: {
              enum9 = 'bc1-rgba-unorm';
              break;
            }
            case 50: {
              enum9 = 'bc1-rgba-unorm-srgb';
              break;
            }
            case 51: {
              enum9 = 'bc2-rgba-unorm';
              break;
            }
            case 52: {
              enum9 = 'bc2-rgba-unorm-srgb';
              break;
            }
            case 53: {
              enum9 = 'bc3-rgba-unorm';
              break;
            }
            case 54: {
              enum9 = 'bc3-rgba-unorm-srgb';
              break;
            }
            case 55: {
              enum9 = 'bc4-r-unorm';
              break;
            }
            case 56: {
              enum9 = 'bc4-r-snorm';
              break;
            }
            case 57: {
              enum9 = 'bc5-rg-unorm';
              break;
            }
            case 58: {
              enum9 = 'bc5-rg-snorm';
              break;
            }
            case 59: {
              enum9 = 'bc6h-rgb-ufloat';
              break;
            }
            case 60: {
              enum9 = 'bc6h-rgb-float';
              break;
            }
            case 61: {
              enum9 = 'bc7-rgba-unorm';
              break;
            }
            case 62: {
              enum9 = 'bc7-rgba-unorm-srgb';
              break;
            }
            case 63: {
              enum9 = 'etc2-rgb8unorm';
              break;
            }
            case 64: {
              enum9 = 'etc2-rgb8unorm-srgb';
              break;
            }
            case 65: {
              enum9 = 'etc2-rgb8a1unorm';
              break;
            }
            case 66: {
              enum9 = 'etc2-rgb8a1unorm-srgb';
              break;
            }
            case 67: {
              enum9 = 'etc2-rgba8unorm';
              break;
            }
            case 68: {
              enum9 = 'etc2-rgba8unorm-srgb';
              break;
            }
            case 69: {
              enum9 = 'eac-r11unorm';
              break;
            }
            case 70: {
              enum9 = 'eac-r11snorm';
              break;
            }
            case 71: {
              enum9 = 'eac-rg11unorm';
              break;
            }
            case 72: {
              enum9 = 'eac-rg11snorm';
              break;
            }
            case 73: {
              enum9 = 'astc4x4-unorm';
              break;
            }
            case 74: {
              enum9 = 'astc4x4-unorm-srgb';
              break;
            }
            case 75: {
              enum9 = 'astc5x4-unorm';
              break;
            }
            case 76: {
              enum9 = 'astc5x4-unorm-srgb';
              break;
            }
            case 77: {
              enum9 = 'astc5x5-unorm';
              break;
            }
            case 78: {
              enum9 = 'astc5x5-unorm-srgb';
              break;
            }
            case 79: {
              enum9 = 'astc6x5-unorm';
              break;
            }
            case 80: {
              enum9 = 'astc6x5-unorm-srgb';
              break;
            }
            case 81: {
              enum9 = 'astc6x6-unorm';
              break;
            }
            case 82: {
              enum9 = 'astc6x6-unorm-srgb';
              break;
            }
            case 83: {
              enum9 = 'astc8x5-unorm';
              break;
            }
            case 84: {
              enum9 = 'astc8x5-unorm-srgb';
              break;
            }
            case 85: {
              enum9 = 'astc8x6-unorm';
              break;
            }
            case 86: {
              enum9 = 'astc8x6-unorm-srgb';
              break;
            }
            case 87: {
              enum9 = 'astc8x8-unorm';
              break;
            }
            case 88: {
              enum9 = 'astc8x8-unorm-srgb';
              break;
            }
            case 89: {
              enum9 = 'astc10x5-unorm';
              break;
            }
            case 90: {
              enum9 = 'astc10x5-unorm-srgb';
              break;
            }
            case 91: {
              enum9 = 'astc10x6-unorm';
              break;
            }
            case 92: {
              enum9 = 'astc10x6-unorm-srgb';
              break;
            }
            case 93: {
              enum9 = 'astc10x8-unorm';
              break;
            }
            case 94: {
              enum9 = 'astc10x8-unorm-srgb';
              break;
            }
            case 95: {
              enum9 = 'astc10x10-unorm';
              break;
            }
            case 96: {
              enum9 = 'astc10x10-unorm-srgb';
              break;
            }
            case 97: {
              enum9 = 'astc12x10-unorm';
              break;
            }
            case 98: {
              enum9 = 'astc12x10-unorm-srgb';
              break;
            }
            case 99: {
              enum9 = 'astc12x12-unorm';
              break;
            }
            case 100: {
              enum9 = 'astc12x12-unorm-srgb';
              break;
            }
            default: {
              throw new TypeError('invalid discriminant specified for GpuTextureFormat');
            }
          }
          result10.push(enum9);
        }
        variant11 = result10;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant13;
    switch (arg8) {
      case 0: {
        variant13 = undefined;
        break;
      }
      case 1: {
        let enum12;
        switch (arg9) {
          case 0: {
            enum12 = 'srgb';
            break;
          }
          case 1: {
            enum12 = 'display-p3';
            break;
          }
          default: {
            throw new TypeError('invalid discriminant specified for PredefinedColorSpace');
          }
        }
        variant13 = enum12;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant16;
    switch (arg10) {
      case 0: {
        variant16 = undefined;
        break;
      }
      case 1: {
        let variant15;
        switch (arg11) {
          case 0: {
            variant15 = undefined;
            break;
          }
          case 1: {
            let enum14;
            switch (arg12) {
              case 0: {
                enum14 = 'standard';
                break;
              }
              case 1: {
                enum14 = 'extended';
                break;
              }
              default: {
                throw new TypeError('invalid discriminant specified for GpuCanvasToneMappingMode');
              }
            }
            variant15 = enum14;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant16 = {
          mode: variant15,
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    let variant18;
    switch (arg13) {
      case 0: {
        variant18 = undefined;
        break;
      }
      case 1: {
        let enum17;
        switch (arg14) {
          case 0: {
            enum17 = 'opaque';
            break;
          }
          case 1: {
            enum17 = 'premultiplied';
            break;
          }
          default: {
            throw new TypeError('invalid discriminant specified for GpuCanvasAlphaMode');
          }
        }
        variant18 = enum17;
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for option');
      }
    }
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.configure"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'configure',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.configure({
          device: rsc3,
          format: enum6,
          usage: variant8,
          viewFormats: variant11,
          colorSpace: variant13,
          toneMapping: variant16,
          alphaMode: variant18,
        }),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    for (const entry of curResourceBorrows) {
      const rsc = entry.rsc ?? entry;
      if (entry.drop) {
        if (rsc[symbolRscHandle]) {
          entry.drop(rsc[symbolRscHandle]);
        }
      }
      rsc[symbolRscHandle] = undefined;
    }
    curResourceBorrows = [];
    _debugLog('[iface="wasi-gfx:surface/surface-webgpu@0.2.0", function="[method]context.configure"][Instruction::Return]', {
      funcName: '[method]context.configure',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline78.fnName = 'wasi-gfx:surface/surface-webgpu@0.2.0#configure';
  
  const _trampoline79 = function(arg0, arg1) {
    var ptr0 = arg0;
    var len0 = arg1;
    var result0 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr0, len0));
    _debugLog('[iface="print", function="print"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'print',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => print(result0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      getOrCreateAsyncState(0).markTrapped(err);
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="print", function="print"][Instruction::Return]', {
      funcName: 'print',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline79.fnName = 'print#print';
  let exports2;
  let callback_0;
  let exports1AsyncLiftStart;
  
  async function start() {
    
    const hostProvided = false;
    getOrCreateAsyncState(0).throwIfTrapped();
    
    const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
      componentIdx: 0,
      isAsync: true,
      isManualAsync: false,
      preserveFutureResult: false,
      entryFnName: 'exports1AsyncLiftStart',
      getCallbackFn: () => callback_0,
      callbackFnName: callback_0,
      errHandling: 'none',
      callingWasmExport: true,
    });
    
    
    const started = await task.enter();
    if (!started) {
      _debugLog('[Instruction::AsyncTaskReturn] failed to enter task', {
        taskID: task.id(),
        subtaskID: task.currentSubtask()?.id(),
      });
      throw new Error("failed to enter task");
    }
    
    
    if (null!== null) {
      task.setReturnMemoryIdx(null);
      task.setReturnMemory(() => null());
    }
    
    
    return await _withGlobalCurrentTaskMetaAsync({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: async () => {
        try {
          
          _debugLog('[iface="start", function="start"][Instruction::CallWasm] enter', {
            funcName: 'start',
            paramCount: 0,
            async: true,
            postReturn: false,
          });
          
          let ret;
          
          try {
            ret =  await exports1AsyncLiftStart();
          } catch (err) {
            
            _debugLog('[Instruction::CallWasm] error during async call', {
              taskID: task.id(),
              err,
            });
            getOrCreateAsyncState(0).markTrapped(err);
            task.setErrored(err);
            task.reject(err);
            task.exit();
            return task.completionPromise();
            
          }
          
          _debugLog('[iface="start", function="start"][Instruction::AsyncTaskReturn]', {
            funcName: 'start',
            paramCount: 0,
            componentIdx: 0,
            postReturn: false,
            hostProvided,
          });
          
          if (hostProvided) {
            _debugLog('[Instruction::AsyncTaskReturn] signaling host-provided async return completion', {
              task: task.id(),
              subtask: subtask?.id(),
              result: ret,
            })
            task.resolve([ret]);
            task.exit();
            return ret;
          }
          
          const componentState = getOrCreateAsyncState(0);
          if (!componentState) { throw new Error('failed to lookup current component state'); }
          
          queueMicrotask(async (resolve, reject) => {
            try {
              _debugLog("[Instruction::AsyncTaskReturn] starting driver loop", {
                fnName: 'start',
                componentInstanceIdx: 0,
                taskID: task.id(),
              });
              await _driverLoop({
                componentInstanceIdx: 0,
                componentState,
                task,
                fnName: 'start',
                isAsync: true,
                callbackResult: ret,
              });
            } catch (err) {
              _debugLog("[Instruction::AsyncTaskReturn] driver loop call failure", { err });
            }
          });
          
          let taskRes = await task.completionPromise();
          if (task.getErrHandling() === 'throw-result-err') {
            if (typeof taskRes !== 'object') {
              return taskRes;
            }
            if (taskRes.tag === 'err') { throw new ComponentError(taskRes.val);}
            if (taskRes.tag === 'ok') { taskRes = taskRes.val; }
          }
          
          return taskRes;
          
          
        } catch (err) {
          if (!task.isResolvedState()) {
            task.setErrored(err);
            task.reject(err);
          }
          if (!task.isExited()) { task.exit({ skipExclusiveLockCheck: true }); }
          throw err;
        }
      },
    });
    
  }
  let trampoline0 = _trampoline0.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 0,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline0.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
    resultLowerFns: [
    _lowerFlatEnum({
      caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline0,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 0,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline0.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
    resultLowerFns: [
    _lowerFlatEnum({
      caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline0,
  },
  );
  function trampoline1(handle) {
    const handleEntry = rscTableRemove(handleTable2, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable2.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable2.delete(handleEntry.rep);
      } else if (RecordOptionGpuSize64[symbolCabiDispose]) {
        RecordOptionGpuSize64[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  let trampoline2 = _trampoline2.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 2,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline2.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuQueue(obj) {
        if (!(obj instanceof GpuQueue)) {
          throw new TypeError('Resource error: Not a valid \"GpuQueue\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt9;
          captureTable9.set(rep, obj);
          handle = rscTableCreateOwn(handleTable9, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline2,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 2,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline2.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuQueue(obj) {
        if (!(obj instanceof GpuQueue)) {
          throw new TypeError('Resource error: Not a valid \"GpuQueue\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt9;
          captureTable9.set(rep, obj);
          handle = rscTableCreateOwn(handleTable9, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline2,
  },
  );
  function trampoline3(handle) {
    const handleEntry = rscTableRemove(handleTable13, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable13.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable13.delete(handleEntry.rep);
      } else if (RecordGpuPipelineConstantValue[symbolCabiDispose]) {
        RecordGpuPipelineConstantValue[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  let trampoline4 = _trampoline4.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 4,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline4.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline4,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 4,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline4.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline4,
  },
  );
  let trampoline5 = _trampoline5.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 5,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline5.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 14)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline5,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 5,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline5.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatBorrow.bind(null, 14)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline5,
  },
  );
  let trampoline6 = _trampoline6.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 6,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline6.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatU32,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline6,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 6,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline6.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 7),_liftFlatU32,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ,
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    ],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline6,
  },
  );
  let trampoline7 = _trampoline7.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 7,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline7.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Gpu(obj) {
        if (!(obj instanceof Gpu)) {
          throw new TypeError('Resource error: Not a valid \"Gpu\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, obj);
          handle = rscTableCreateOwn(handleTable0, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline7,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 7,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline7.manuallyAsync,
    paramLiftFns: [],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Gpu(obj) {
        if (!(obj instanceof Gpu)) {
          throw new TypeError('Resource error: Not a valid \"Gpu\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, obj);
          handle = rscTableCreateOwn(handleTable0, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline7,
  },
  );
  let trampoline8 = _trampoline8.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 8,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline8.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['height', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['width', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],], size32: 16, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Surface(obj) {
        if (!(obj instanceof Surface)) {
          throw new TypeError('Resource error: Not a valid \"Surface\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt16;
          captureTable16.set(rep, obj);
          handle = rscTableCreateOwn(handleTable16, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline8,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 8,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline8.manuallyAsync,
    paramLiftFns: [_liftFlatRecord({ fieldMetas: [['height', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['width', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],], size32: 16, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Surface(obj) {
        if (!(obj instanceof Surface)) {
          throw new TypeError('Resource error: Not a valid \"Surface\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt16;
          captureTable16.set(rep, obj);
          handle = rscTableCreateOwn(handleTable16, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline8,
  },
  );
  let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 9,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline9.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 0,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['height', _liftFlatU32, 4, 4],['width', _liftFlatU32, 4, 4],], size32: 8, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['height', _lowerFlatU32, 4, 4 ],['width', _lowerFlatU32, 4, 4 ],], size32: 8, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(27))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 4,
        size32: 8,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline9,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 9,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline9.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 0,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['height', _liftFlatU32, 4, 4],['width', _liftFlatU32, 4, 4],], size32: 8, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['height', _lowerFlatU32, 4, 4 ],['width', _lowerFlatU32, 4, 4 ],], size32: 8, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(27))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 4,
        size32: 8,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline9,
  },
  );
  let trampoline10 = _trampoline10.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 10,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline10.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 1,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['nothing', _liftFlatBool, 1, 1],], size32: 1, align32: 1 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['nothing', _lowerFlatBool, 1, 1 ],], size32: 1, align32: 1 }),
        payloadTypeName: 'Record(TypeRecordIndex(28))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 1,
        align32: 1,
        size32: 1,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline10,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 10,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline10.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 1,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['nothing', _liftFlatBool, 1, 1],], size32: 1, align32: 1 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['nothing', _lowerFlatBool, 1, 1 ],], size32: 1, align32: 1 }),
        payloadTypeName: 'Record(TypeRecordIndex(28))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 1,
        align32: 1,
        size32: 1,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline10,
  },
  );
  let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 11,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline11.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline11,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 11,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline11.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline11,
  },
  );
  let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 12,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline12.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline12,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 12,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline12.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline12,
  },
  );
  let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 13,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline13.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline13,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 13,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline13.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 2,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
        payloadTypeName: 'Record(TypeRecordIndex(29))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 2,
        align32: 8,
        size32: 16,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline13,
  },
  );
  let trampoline14 = _trampoline14.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 14,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline14.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 3,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 9,
        align32: 4,
        size32: 20,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline14,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 14,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline14.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 3,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 9,
        align32: 4,
        size32: 20,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline14,
  },
  );
  let trampoline15 = _trampoline15.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 15,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline15.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 3,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 9,
        align32: 4,
        size32: 20,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline15,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 15,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline15.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatStream({
      streamTableIdx: 3,
      componentIdx: 0,
      elemMeta: {
        liftFn: _liftFlatRecord({ fieldMetas: [['key', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['text', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
        lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', 
          _lowerFlatEnum({
            caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
        })
        , 2, 1 ],['text', 
        _lowerFlatOption({
          caseMetas: [
          [ 'none', null, 0, 0, 0 ],
          [ 'some', _lowerFlatStringAny, 8, 4, 2],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
        })
        , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
        payloadTypeName: 'Record(TypeRecordIndex(30))',
        isNone: false,
        isNumeric: false,
        isBorrowed: false,
        isAsyncValue: false,
        typedArray: undefined,
        flatCount: 9,
        align32: 4,
        size32: 20,
      },
    })
    ],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline15,
  },
  );
  let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 16,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline16.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Context(obj) {
        if (!(obj instanceof Context)) {
          throw new TypeError('Resource error: Not a valid \"Context\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline16,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 16,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline16.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 16)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Context(obj) {
        if (!(obj instanceof Context)) {
          throw new TypeError('Resource error: Not a valid \"Context\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt17;
          captureTable17.set(rep, obj);
          handle = rscTableCreateOwn(handleTable17, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline16,
  },
  );
  let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 17,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline17.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuTexture(obj) {
        if (!(obj instanceof GpuTexture)) {
          throw new TypeError('Resource error: Not a valid \"GpuTexture\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline17,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 17,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline17.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuTexture(obj) {
        if (!(obj instanceof GpuTexture)) {
          throw new TypeError('Resource error: Not a valid \"GpuTexture\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt15;
          captureTable15.set(rep, obj);
          handle = rscTableCreateOwn(handleTable15, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline17,
  },
  );
  let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 18,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline18.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline18,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 18,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline18.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17)],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: null,
    stringEncoding: 'utf8',
    getMemoryFn: () => null,
    getReallocFn: undefined,
    importFn: _trampoline18,
  },
  );
  const trampoline19 = new WebAssembly.Suspending(_suspendingImport(0, subtaskCancel.bind(null, 0, false)));
  
  function trampoline20(handle) {
    const handleEntry = rscTableRemove(handleTable3, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable3.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable3.delete(handleEntry.rep);
      } else if (GpuDevice[symbolCabiDispose]) {
        GpuDevice[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline21(handle) {
    const handleEntry = rscTableRemove(handleTable8, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable8.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable8.delete(handleEntry.rep);
      } else if (GpuCommandBuffer[symbolCabiDispose]) {
        GpuCommandBuffer[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline22(handle) {
    const handleEntry = rscTableRemove(handleTable15, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable15.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable15.delete(handleEntry.rep);
      } else if (GpuTexture[symbolCabiDispose]) {
        GpuTexture[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline23(handle) {
    const handleEntry = rscTableRemove(handleTable5, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable5.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable5.delete(handleEntry.rep);
      } else if (GpuTextureView[symbolCabiDispose]) {
        GpuTextureView[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline24(handle) {
    const handleEntry = rscTableRemove(handleTable14, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable14.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable14.delete(handleEntry.rep);
      } else if (GpuRenderPipeline[symbolCabiDispose]) {
        GpuRenderPipeline[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline25(handle) {
    const handleEntry = rscTableRemove(handleTable9, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable9.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable9.delete(handleEntry.rep);
      } else if (GpuQueue[symbolCabiDispose]) {
        GpuQueue[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline26(handle) {
    const handleEntry = rscTableRemove(handleTable4, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable4.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable4.delete(handleEntry.rep);
      } else if (GpuCommandEncoder[symbolCabiDispose]) {
        GpuCommandEncoder[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline27(handle) {
    const handleEntry = rscTableRemove(handleTable0, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable0.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable0.delete(handleEntry.rep);
      } else if (Gpu[symbolCabiDispose]) {
        Gpu[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline28(handle) {
    const handleEntry = rscTableRemove(handleTable12, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable12.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable12.delete(handleEntry.rep);
      } else if (GpuShaderModule[symbolCabiDispose]) {
        GpuShaderModule[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline29(handle) {
    const handleEntry = rscTableRemove(handleTable7, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable7.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable7.delete(handleEntry.rep);
      } else if (GpuRenderPassEncoder[symbolCabiDispose]) {
        GpuRenderPassEncoder[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline30(handle) {
    const handleEntry = rscTableRemove(handleTable1, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable1.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable1.delete(handleEntry.rep);
      } else if (GpuAdapter[symbolCabiDispose]) {
        GpuAdapter[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline31(handle) {
    const handleEntry = rscTableRemove(handleTable17, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable17.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable17.delete(handleEntry.rep);
      } else if (Context[symbolCabiDispose]) {
        Context[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline32(handle) {
    const handleEntry = rscTableRemove(handleTable11, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable11.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable11.delete(handleEntry.rep);
      } else if (GpuPipelineLayout[symbolCabiDispose]) {
        GpuPipelineLayout[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  function trampoline33(handle) {
    const handleEntry = rscTableRemove(handleTable16, handle);
    if (handleEntry.own) {
      
      const rsc = captureTable16.get(handleEntry.rep);
      if (rsc) {
        if (rsc[symbolDispose]) rsc[symbolDispose]();
        captureTable16.delete(handleEntry.rep);
      } else if (Surface[symbolCabiDispose]) {
        Surface[symbolCabiDispose](handleEntry.rep);
      }
    }
  }
  
  const trampoline34 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelWrite.bind(null, {
    streamTableIdx: 0,
    isAsync: false,
    componentIdx: 0,
  })));
  
  
  const trampoline35 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelRead.bind(null, {
    streamTableIdx: 0,
    isAsync: false,
    componentIdx: 0,
  })));
  
  const trampoline36 = streamDropWritable.bind(null, {
    streamTableIdx: 0,
    componentIdx: 0,
  });
  
  const trampoline37 = streamDropReadable.bind(null, {
    streamTableIdx: 0,
    componentIdx: 0,
  });
  
  const trampoline38 = streamNew.bind(null, {
    streamTableIdx: 0,
    callerComponentIdx: 0,
    elemMeta: {
      liftFn: _liftFlatRecord({ fieldMetas: [['height', _liftFlatU32, 4, 4],['width', _liftFlatU32, 4, 4],], size32: 8, align32: 4 }),
      lowerFn: _lowerFlatRecord({ fieldMetas: [['height', _lowerFlatU32, 4, 4 ],['width', _lowerFlatU32, 4, 4 ],], size32: 8, align32: 4 }),
      payloadTypeName: 'Record(TypeRecordIndex(27))',
      isNone: false,
      isNumeric: false,
      isBorrowed: false,
      isAsyncValue: false,
      typedArray: undefined,
      flatCount: 2,
      align32: 4,
      size32: 8,
    },
  });
  
  
  const trampoline39 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelWrite.bind(null, {
    streamTableIdx: 1,
    isAsync: false,
    componentIdx: 0,
  })));
  
  
  const trampoline40 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelRead.bind(null, {
    streamTableIdx: 1,
    isAsync: false,
    componentIdx: 0,
  })));
  
  const trampoline41 = streamDropWritable.bind(null, {
    streamTableIdx: 1,
    componentIdx: 0,
  });
  
  const trampoline42 = streamDropReadable.bind(null, {
    streamTableIdx: 1,
    componentIdx: 0,
  });
  
  const trampoline43 = streamNew.bind(null, {
    streamTableIdx: 1,
    callerComponentIdx: 0,
    elemMeta: {
      liftFn: _liftFlatRecord({ fieldMetas: [['nothing', _liftFlatBool, 1, 1],], size32: 1, align32: 1 }),
      lowerFn: _lowerFlatRecord({ fieldMetas: [['nothing', _lowerFlatBool, 1, 1 ],], size32: 1, align32: 1 }),
      payloadTypeName: 'Record(TypeRecordIndex(28))',
      isNone: false,
      isNumeric: false,
      isBorrowed: false,
      isAsyncValue: false,
      typedArray: undefined,
      flatCount: 1,
      align32: 1,
      size32: 1,
    },
  });
  
  
  const trampoline44 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelWrite.bind(null, {
    streamTableIdx: 2,
    isAsync: false,
    componentIdx: 0,
  })));
  
  
  const trampoline45 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelRead.bind(null, {
    streamTableIdx: 2,
    isAsync: false,
    componentIdx: 0,
  })));
  
  const trampoline46 = streamDropWritable.bind(null, {
    streamTableIdx: 2,
    componentIdx: 0,
  });
  
  const trampoline47 = streamDropReadable.bind(null, {
    streamTableIdx: 2,
    componentIdx: 0,
  });
  
  const trampoline48 = streamNew.bind(null, {
    streamTableIdx: 2,
    callerComponentIdx: 0,
    elemMeta: {
      liftFn: _liftFlatRecord({ fieldMetas: [['x', _liftFlatFloat64, 8, 8],['y', _liftFlatFloat64, 8, 8],], size32: 16, align32: 8 }),
      lowerFn: _lowerFlatRecord({ fieldMetas: [['x', _lowerFlatFloat64, 8, 8 ],['y', _lowerFlatFloat64, 8, 8 ],], size32: 16, align32: 8 }),
      payloadTypeName: 'Record(TypeRecordIndex(29))',
      isNone: false,
      isNumeric: false,
      isBorrowed: false,
      isAsyncValue: false,
      typedArray: undefined,
      flatCount: 2,
      align32: 8,
      size32: 16,
    },
  });
  
  
  const trampoline49 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelWrite.bind(null, {
    streamTableIdx: 3,
    isAsync: false,
    componentIdx: 0,
  })));
  
  
  const trampoline50 = new WebAssembly.Suspending(_suspendingImport(0, streamCancelRead.bind(null, {
    streamTableIdx: 3,
    isAsync: false,
    componentIdx: 0,
  })));
  
  const trampoline51 = streamDropWritable.bind(null, {
    streamTableIdx: 3,
    componentIdx: 0,
  });
  
  const trampoline52 = streamDropReadable.bind(null, {
    streamTableIdx: 3,
    componentIdx: 0,
  });
  
  const trampoline53 = streamNew.bind(null, {
    streamTableIdx: 3,
    callerComponentIdx: 0,
    elemMeta: {
      liftFn: _liftFlatRecord({ fieldMetas: [['key', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['text', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['altKey', _liftFlatBool, 1, 1],['ctrlKey', _liftFlatBool, 1, 1],['metaKey', _liftFlatBool, 1, 1],['shiftKey', _liftFlatBool, 1, 1],], size32: 20, align32: 4 }),
      lowerFn: _lowerFlatRecord({ fieldMetas: [['key', 
      _lowerFlatOption({
        caseMetas: [
        [ 'none', null, 0, 0, 0 ],
        [ 'some', 
        _lowerFlatEnum({
          caseMetas: [['backquote', null, 1, 1, 1],['backslash', null, 1, 1, 1],['bracket-left', null, 1, 1, 1],['bracket-right', null, 1, 1, 1],['comma', null, 1, 1, 1],['digit0', null, 1, 1, 1],['digit1', null, 1, 1, 1],['digit2', null, 1, 1, 1],['digit3', null, 1, 1, 1],['digit4', null, 1, 1, 1],['digit5', null, 1, 1, 1],['digit6', null, 1, 1, 1],['digit7', null, 1, 1, 1],['digit8', null, 1, 1, 1],['digit9', null, 1, 1, 1],['equal', null, 1, 1, 1],['intl-backslash', null, 1, 1, 1],['intl-ro', null, 1, 1, 1],['intl-yen', null, 1, 1, 1],['key-a', null, 1, 1, 1],['key-b', null, 1, 1, 1],['key-c', null, 1, 1, 1],['key-d', null, 1, 1, 1],['key-e', null, 1, 1, 1],['key-f', null, 1, 1, 1],['key-g', null, 1, 1, 1],['key-h', null, 1, 1, 1],['key-i', null, 1, 1, 1],['key-j', null, 1, 1, 1],['key-k', null, 1, 1, 1],['key-l', null, 1, 1, 1],['key-m', null, 1, 1, 1],['key-n', null, 1, 1, 1],['key-o', null, 1, 1, 1],['key-p', null, 1, 1, 1],['key-q', null, 1, 1, 1],['key-r', null, 1, 1, 1],['key-s', null, 1, 1, 1],['key-t', null, 1, 1, 1],['key-u', null, 1, 1, 1],['key-v', null, 1, 1, 1],['key-w', null, 1, 1, 1],['key-x', null, 1, 1, 1],['key-y', null, 1, 1, 1],['key-z', null, 1, 1, 1],['minus', null, 1, 1, 1],['period', null, 1, 1, 1],['quote', null, 1, 1, 1],['semicolon', null, 1, 1, 1],['slash', null, 1, 1, 1],['alt-left', null, 1, 1, 1],['alt-right', null, 1, 1, 1],['backspace', null, 1, 1, 1],['caps-lock', null, 1, 1, 1],['context-menu', null, 1, 1, 1],['control-left', null, 1, 1, 1],['control-right', null, 1, 1, 1],['enter', null, 1, 1, 1],['meta-left', null, 1, 1, 1],['meta-right', null, 1, 1, 1],['shift-left', null, 1, 1, 1],['shift-right', null, 1, 1, 1],['space', null, 1, 1, 1],['tab', null, 1, 1, 1],['convert', null, 1, 1, 1],['kana-mode', null, 1, 1, 1],['lang1', null, 1, 1, 1],['lang2', null, 1, 1, 1],['lang3', null, 1, 1, 1],['lang4', null, 1, 1, 1],['lang5', null, 1, 1, 1],['non-convert', null, 1, 1, 1],['delete', null, 1, 1, 1],['end', null, 1, 1, 1],['help', null, 1, 1, 1],['home', null, 1, 1, 1],['insert', null, 1, 1, 1],['page-down', null, 1, 1, 1],['page-up', null, 1, 1, 1],['arrow-down', null, 1, 1, 1],['arrow-left', null, 1, 1, 1],['arrow-right', null, 1, 1, 1],['arrow-up', null, 1, 1, 1],['num-lock', null, 1, 1, 1],['numpad0', null, 1, 1, 1],['numpad1', null, 1, 1, 1],['numpad2', null, 1, 1, 1],['numpad3', null, 1, 1, 1],['numpad4', null, 1, 1, 1],['numpad5', null, 1, 1, 1],['numpad6', null, 1, 1, 1],['numpad7', null, 1, 1, 1],['numpad8', null, 1, 1, 1],['numpad9', null, 1, 1, 1],['numpad-add', null, 1, 1, 1],['numpad-backspace', null, 1, 1, 1],['numpad-clear', null, 1, 1, 1],['numpad-clear-entry', null, 1, 1, 1],['numpad-comma', null, 1, 1, 1],['numpad-decimal', null, 1, 1, 1],['numpad-divide', null, 1, 1, 1],['numpad-enter', null, 1, 1, 1],['numpad-equal', null, 1, 1, 1],['numpad-hash', null, 1, 1, 1],['numpad-memory-add', null, 1, 1, 1],['numpad-memory-clear', null, 1, 1, 1],['numpad-memory-recall', null, 1, 1, 1],['numpad-memory-store', null, 1, 1, 1],['numpad-memory-subtract', null, 1, 1, 1],['numpad-multiply', null, 1, 1, 1],['numpad-paren-left', null, 1, 1, 1],['numpad-paren-right', null, 1, 1, 1],['numpad-star', null, 1, 1, 1],['numpad-subtract', null, 1, 1, 1],['escape', null, 1, 1, 1],['f1', null, 1, 1, 1],['f2', null, 1, 1, 1],['f3', null, 1, 1, 1],['f4', null, 1, 1, 1],['f5', null, 1, 1, 1],['f6', null, 1, 1, 1],['f7', null, 1, 1, 1],['f8', null, 1, 1, 1],['f9', null, 1, 1, 1],['f10', null, 1, 1, 1],['f11', null, 1, 1, 1],['f12', null, 1, 1, 1],['fn', null, 1, 1, 1],['fn-lock', null, 1, 1, 1],['print-screen', null, 1, 1, 1],['scroll-lock', null, 1, 1, 1],['pause', null, 1, 1, 1],['browser-back', null, 1, 1, 1],['browser-favorites', null, 1, 1, 1],['browser-forward', null, 1, 1, 1],['browser-home', null, 1, 1, 1],['browser-refresh', null, 1, 1, 1],['browser-search', null, 1, 1, 1],['browser-stop', null, 1, 1, 1],['eject', null, 1, 1, 1],['launch-app1', null, 1, 1, 1],['launch-app2', null, 1, 1, 1],['launch-mail', null, 1, 1, 1],['media-play-pause', null, 1, 1, 1],['media-select', null, 1, 1, 1],['media-stop', null, 1, 1, 1],['media-track-next', null, 1, 1, 1],['media-track-previous', null, 1, 1, 1],['power', null, 1, 1, 1],['sleep', null, 1, 1, 1],['audio-volume-down', null, 1, 1, 1],['audio-volume-mute', null, 1, 1, 1],['audio-volume-up', null, 1, 1, 1],['wake-up', null, 1, 1, 1],['hyper', null, 1, 1, 1],['super', null, 1, 1, 1],['turbo', null, 1, 1, 1],['abort', null, 1, 1, 1],['resume', null, 1, 1, 1],['suspend', null, 1, 1, 1],['again', null, 1, 1, 1],['copy', null, 1, 1, 1],['cut', null, 1, 1, 1],['find', null, 1, 1, 1],['open', null, 1, 1, 1],['paste', null, 1, 1, 1],['props', null, 1, 1, 1],['select', null, 1, 1, 1],['undo', null, 1, 1, 1],['hiragana', null, 1, 1, 1],['katakana', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
      })
      , 2, 1 ],['text', 
      _lowerFlatOption({
        caseMetas: [
        [ 'none', null, 0, 0, 0 ],
        [ 'some', _lowerFlatStringAny, 8, 4, 2],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
      })
      , 12, 4 ],['altKey', _lowerFlatBool, 1, 1 ],['ctrlKey', _lowerFlatBool, 1, 1 ],['metaKey', _lowerFlatBool, 1, 1 ],['shiftKey', _lowerFlatBool, 1, 1 ],], size32: 20, align32: 4 }),
      payloadTypeName: 'Record(TypeRecordIndex(30))',
      isNone: false,
      isNumeric: false,
      isBorrowed: false,
      isAsyncValue: false,
      typedArray: undefined,
      flatCount: 9,
      align32: 4,
      size32: 20,
    },
  });
  
  const trampoline54 = taskReturn.bind(
  null,
  {
    componentIdx: 0,
    useDirectParams: true,
    getMemoryFn: () => null,
    memoryIdx: null,
    callbackFnIdx: null,
    liftFns: [],
    lowerFns: [],
    stringEncoding: 'utf8',
  },
  );
  const trampoline55 = subtaskDrop.bind(
  null,
  0,
  );
  const trampoline56 = waitableSetDrop.bind(null, 0);
  
  const trampoline57 = waitableJoin.bind(null, 0);
  
  const trampoline58 = waitableSetNew.bind(null, 0);
  
  const trampoline59 = taskCancel.bind(null, 0);
  
  let trampoline60 = new WebAssembly.Suspending(_suspendingImport(0, _lowerImport.bind(
  null,
  {
    trampolineIdx: 60,
    componentIdx: 0,
    isAsync: true,
    isManualAsync: _trampoline60.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 0),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['featureLevel', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['powerPreference', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['low-power', null, 1, 1, 1],['high-performance', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['forceFallbackAdapter', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['xrCompatible', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 20, align32: 4 }), 20, 4, 9, ['i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 24,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 10,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    ],
    resultLowerFns: [
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_GpuAdapter(obj) {
          if (!(obj instanceof GpuAdapter)) {
            throw new TypeError('Resource error: Not a valid \"GpuAdapter\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt1;
            captureTable1.set(rep, obj);
            handle = rscTableCreateOwn(handleTable1, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: true,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline60,
  },
  )));
  let trampoline61 = new WebAssembly.Suspending(_suspendingImport(0, _lowerImport.bind(
  null,
  {
    trampolineIdx: 61,
    componentIdx: 0,
    isAsync: true,
    isManualAsync: _trampoline61.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 1),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['requiredFeatures', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatList({
          elemLiftFn: 
          _liftFlatEnum({
            caseMetas: [['core-features-and-limits', null, 1, 1, 1],['depth-clip-control', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['texture-compression-bc', null, 1, 1, 1],['texture-compression-bc-sliced3d', null, 1, 1, 1],['texture-compression-etc2', null, 1, 1, 1],['texture-compression-astc', null, 1, 1, 1],['texture-compression-astc-sliced3d', null, 1, 1, 1],['timestamp-query', null, 1, 1, 1],['indirect-first-instance', null, 1, 1, 1],['shader-f16', null, 1, 1, 1],['rg11b10ufloat-renderable', null, 1, 1, 1],['bgra8unorm-storage', null, 1, 1, 1],['float32-filterable', null, 1, 1, 1],['float32-blendable', null, 1, 1, 1],['clip-distances', null, 1, 1, 1],['dual-source-blending', null, 1, 1, 1],['subgroups', null, 1, 1, 1],['texture-formats-tier1', null, 1, 1, 1],['texture-formats-tier2', null, 1, 1, 1],['primitive-index', null, 1, 1, 1],['texture-component-swizzle', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          ,
          elemAlign32: 1,
          elemSize32: 1,
          typedArray: undefined,
        }), 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['requiredLimits', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatOwn({
          componentIdx: 0,
          classNameFn: () => RecordOptionGpuSize64,
          createResourceFn: 
          (handle) => {
            const rep = handleTable2[(handle << 1) + 1] & ~T_FLAG;
            let resourceObj = captureTable2.get(rep);
            if (!resourceObj) {
              resourceObj = Object.create(RecordOptionGpuSize64.prototype);
              Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
              Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
            } else {
              captureTable2.delete(rep);
            }
            rscTableRemove(handleTable2, handle);
            return resourceObj;
          }
          ,
        })
        , 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['defaultQueue', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['label', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],], size32: 12, align32: 4 }), 12, 4, 3, ['i32','i32','i32'] ],
        ],
        variantSize32: 16,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 4,
        variantPayloadFlatTypes: ['i32','i32','i32'],
      })
      , 16, 4],['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 48, align32: 4 }), 48, 4, 12, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 52,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 13,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    ],
    resultLowerFns: [
    _lowerFlatResult({
      caseMetas: [
      [ 'ok', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_GpuDevice(obj) {
          if (!(obj instanceof GpuDevice)) {
            throw new TypeError('Resource error: Not a valid \"GpuDevice\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt3;
            captureTable3.set(rep, obj);
            handle = rscTableCreateOwn(handleTable3, rep);
          }
          return handle;
        }
        ,
      }), 16, 4, 4 ],
      [ 'err', _lowerFlatRecord({ fieldMetas: [['kind', _lowerFlatVariant({
        caseMetas: [[ 'type-error', null, 0, 0, 0 ],[ 'operation-error', null, 0, 0, 0 ],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      } ), 1, 1 ],['message', _lowerFlatStringAny, 8, 4 ],], size32: 12, align32: 4 }), 16, 4, 4 ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
    })
    ],
    hasResultPointer: true,
    funcTypeIsAsync: true,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: () => realloc0,
    importFn: _trampoline61,
  },
  )));
  let trampoline62 = _trampoline62.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 62,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline62.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatRecord({ fieldMetas: [['colorAttachments', _liftFlatList({
      elemLiftFn: 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['view', _liftFlatBorrow.bind(null, 5), 4, 4],['depthSlice', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
          ],
          variantSize32: 8,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 8, 4],['resolveTarget', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatBorrow.bind(null, 5), 4, 4, 1, ['i32'] ],
          ],
          variantSize32: 8,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 8, 4],['clearValue', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['r', _liftFlatFloat64, 8, 8],['g', _liftFlatFloat64, 8, 8],['b', _liftFlatFloat64, 8, 8],['a', _liftFlatFloat64, 8, 8],], size32: 32, align32: 8 }), 32, 8, 4, ['f64','f64','f64','f64'] ],
          ],
          variantSize32: 40,
          variantAlign32: 8,
          variantPayloadOffset32: 8,
          variantFlatCount: 5,
          variantPayloadFlatTypes: ['f64','f64','f64','f64'],
        })
        , 40, 8],['loadOp', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1],['storeOp', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1],], size32: 72, align32: 8 }), 72, 8, 12, ['i32','i32','i32','i32','i32','i32','f64','f64','f64','f64','i32','i32'] ],
        ],
        variantSize32: 80,
        variantAlign32: 8,
        variantPayloadOffset32: 8,
        variantFlatCount: 13,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','f64','f64','f64','f64','i32','i32'],
      })
      ,
      elemAlign32: 8,
      elemSize32: 80,
      typedArray: undefined,
    }), 8, 4],['depthStencilAttachment', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['view', _liftFlatBorrow.bind(null, 5), 4, 4],['depthClearValue', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],['depthLoadOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthStoreOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthReadOnly', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilClearValue', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['stencilLoadOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilStoreOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilReadOnly', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 36, align32: 4 }), 36, 4, null, null ],
      ],
      variantSize32: 40,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    , 40, 4],['occlusionQuerySet', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatBorrow.bind(null, 6), 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['timestampWrites', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['querySet', _liftFlatBorrow.bind(null, 6), 4, 4],['beginningOfPassWriteIndex', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['endOfPassWriteIndex', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],], size32: 20, align32: 4 }), 20, 4, 5, ['i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 24,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 6,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32'],
    })
    , 24, 4],['maxDrawCount', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU64, 8, 8, 1, ['i64'] ],
      ],
      variantSize32: 16,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i64'],
    })
    , 16, 8],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 112, align32: 8 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuRenderPassEncoder(obj) {
        if (!(obj instanceof GpuRenderPassEncoder)) {
          throw new TypeError('Resource error: Not a valid \"GpuRenderPassEncoder\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt7;
          captureTable7.set(rep, obj);
          handle = rscTableCreateOwn(handleTable7, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline62,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 62,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline62.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 4),_liftFlatRecord({ fieldMetas: [['colorAttachments', _liftFlatList({
      elemLiftFn: 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['view', _liftFlatBorrow.bind(null, 5), 4, 4],['depthSlice', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
          ],
          variantSize32: 8,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 8, 4],['resolveTarget', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatBorrow.bind(null, 5), 4, 4, 1, ['i32'] ],
          ],
          variantSize32: 8,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 8, 4],['clearValue', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['r', _liftFlatFloat64, 8, 8],['g', _liftFlatFloat64, 8, 8],['b', _liftFlatFloat64, 8, 8],['a', _liftFlatFloat64, 8, 8],], size32: 32, align32: 8 }), 32, 8, 4, ['f64','f64','f64','f64'] ],
          ],
          variantSize32: 40,
          variantAlign32: 8,
          variantPayloadOffset32: 8,
          variantFlatCount: 5,
          variantPayloadFlatTypes: ['f64','f64','f64','f64'],
        })
        , 40, 8],['loadOp', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1],['storeOp', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1],], size32: 72, align32: 8 }), 72, 8, 12, ['i32','i32','i32','i32','i32','i32','f64','f64','f64','f64','i32','i32'] ],
        ],
        variantSize32: 80,
        variantAlign32: 8,
        variantPayloadOffset32: 8,
        variantFlatCount: 13,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','f64','f64','f64','f64','i32','i32'],
      })
      ,
      elemAlign32: 8,
      elemSize32: 80,
      typedArray: undefined,
    }), 8, 4],['depthStencilAttachment', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['view', _liftFlatBorrow.bind(null, 5), 4, 4],['depthClearValue', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],['depthLoadOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthStoreOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthReadOnly', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilClearValue', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['stencilLoadOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['load', null, 1, 1, 1],['clear', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilStoreOp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['store', null, 1, 1, 1],['discard', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilReadOnly', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 36, align32: 4 }), 36, 4, null, null ],
      ],
      variantSize32: 40,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    , 40, 4],['occlusionQuerySet', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatBorrow.bind(null, 6), 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['timestampWrites', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['querySet', _liftFlatBorrow.bind(null, 6), 4, 4],['beginningOfPassWriteIndex', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['endOfPassWriteIndex', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],], size32: 20, align32: 4 }), 20, 4, 5, ['i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 24,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 6,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32'],
    })
    , 24, 4],['maxDrawCount', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU64, 8, 8, 1, ['i64'] ],
      ],
      variantSize32: 16,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i64'],
    })
    , 16, 8],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 112, align32: 8 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuRenderPassEncoder(obj) {
        if (!(obj instanceof GpuRenderPassEncoder)) {
          throw new TypeError('Resource error: Not a valid \"GpuRenderPassEncoder\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt7;
          captureTable7.set(rep, obj);
          handle = rscTableCreateOwn(handleTable7, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline62,
  },
  );
  let trampoline63 = _trampoline63.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 63,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline63.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 4),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 12, align32: 4 }), 12, 4, 3, ['i32','i32','i32'] ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
      variantPayloadFlatTypes: ['i32','i32','i32'],
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuCommandBuffer(obj) {
        if (!(obj instanceof GpuCommandBuffer)) {
          throw new TypeError('Resource error: Not a valid \"GpuCommandBuffer\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt8;
          captureTable8.set(rep, obj);
          handle = rscTableCreateOwn(handleTable8, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline63,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 63,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline63.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 4),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 12, align32: 4 }), 12, 4, 3, ['i32','i32','i32'] ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
      variantPayloadFlatTypes: ['i32','i32','i32'],
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuCommandBuffer(obj) {
        if (!(obj instanceof GpuCommandBuffer)) {
          throw new TypeError('Resource error: Not a valid \"GpuCommandBuffer\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt8;
          captureTable8.set(rep, obj);
          handle = rscTableCreateOwn(handleTable8, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline63,
  },
  );
  let trampoline64 = _trampoline64.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 64,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline64.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['bindGroupLayouts', _liftFlatList({
      elemLiftFn: 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBorrow.bind(null, 10), 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      ,
      elemAlign32: 4,
      elemSize32: 8,
      typedArray: undefined,
    }), 8, 4],['immediateSize', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 28, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuPipelineLayout(obj) {
        if (!(obj instanceof GpuPipelineLayout)) {
          throw new TypeError('Resource error: Not a valid \"GpuPipelineLayout\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, obj);
          handle = rscTableCreateOwn(handleTable11, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline64,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 64,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline64.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['bindGroupLayouts', _liftFlatList({
      elemLiftFn: 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBorrow.bind(null, 10), 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      ,
      elemAlign32: 4,
      elemSize32: 8,
      typedArray: undefined,
    }), 8, 4],['immediateSize', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 28, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuPipelineLayout(obj) {
        if (!(obj instanceof GpuPipelineLayout)) {
          throw new TypeError('Resource error: Not a valid \"GpuPipelineLayout\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt11;
          captureTable11.set(rep, obj);
          handle = rscTableCreateOwn(handleTable11, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline64,
  },
  );
  let trampoline65 = _trampoline65.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 65,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline65.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['code', _liftFlatStringAny, 8, 4],['compilationHints', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatRecord({ fieldMetas: [['entryPoint', _liftFlatStringAny, 8, 4],['layout', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatVariant({
            caseMetas: [['specific', _liftFlatBorrow.bind(null, 11), 4, 4, 1, ['i32']],['auto', null, 0, 0, 0, []],],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          } ), 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],], size32: 20, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 20,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 32, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuShaderModule(obj) {
        if (!(obj instanceof GpuShaderModule)) {
          throw new TypeError('Resource error: Not a valid \"GpuShaderModule\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt12;
          captureTable12.set(rep, obj);
          handle = rscTableCreateOwn(handleTable12, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline65,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 65,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline65.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['code', _liftFlatStringAny, 8, 4],['compilationHints', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: _liftFlatRecord({ fieldMetas: [['entryPoint', _liftFlatStringAny, 8, 4],['layout', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatVariant({
            caseMetas: [['specific', _liftFlatBorrow.bind(null, 11), 4, 4, 1, ['i32']],['auto', null, 0, 0, 0, []],],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          } ), 8, 4, 2, ['i32','i32'] ],
          ],
          variantSize32: 12,
          variantAlign32: 4,
          variantPayloadOffset32: 4,
          variantFlatCount: 3,
          variantPayloadFlatTypes: ['i32','i32'],
        })
        , 12, 4],], size32: 20, align32: 4 }),
        elemAlign32: 4,
        elemSize32: 20,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 32, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuShaderModule(obj) {
        if (!(obj instanceof GpuShaderModule)) {
          throw new TypeError('Resource error: Not a valid \"GpuShaderModule\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt12;
          captureTable12.set(rep, obj);
          handle = rscTableCreateOwn(handleTable12, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline65,
  },
  );
  let trampoline66 = _trampoline66.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 66,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline66.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['vertex', _liftFlatRecord({ fieldMetas: [['buffers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['arrayStride', _liftFlatU64, 8, 8],['stepMode', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', 
            _liftFlatEnum({
              caseMetas: [['vertex', null, 1, 1, 1],['instance', null, 1, 1, 1],],
              variantSize32: 1,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 1,
            })
            , 1, 1, 1, ['i32'] ],
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          })
          , 2, 1],['attributes', _liftFlatList({
            elemLiftFn: _liftFlatRecord({ fieldMetas: [['format', 
            _liftFlatEnum({
              caseMetas: [['uint8', null, 1, 1, 1],['uint8x2', null, 1, 1, 1],['uint8x4', null, 1, 1, 1],['sint8', null, 1, 1, 1],['sint8x2', null, 1, 1, 1],['sint8x4', null, 1, 1, 1],['unorm8', null, 1, 1, 1],['unorm8x2', null, 1, 1, 1],['unorm8x4', null, 1, 1, 1],['snorm8', null, 1, 1, 1],['snorm8x2', null, 1, 1, 1],['snorm8x4', null, 1, 1, 1],['uint16', null, 1, 1, 1],['uint16x2', null, 1, 1, 1],['uint16x4', null, 1, 1, 1],['sint16', null, 1, 1, 1],['sint16x2', null, 1, 1, 1],['sint16x4', null, 1, 1, 1],['unorm16', null, 1, 1, 1],['unorm16x2', null, 1, 1, 1],['unorm16x4', null, 1, 1, 1],['snorm16', null, 1, 1, 1],['snorm16x2', null, 1, 1, 1],['snorm16x4', null, 1, 1, 1],['float16', null, 1, 1, 1],['float16x2', null, 1, 1, 1],['float16x4', null, 1, 1, 1],['float32', null, 1, 1, 1],['float32x2', null, 1, 1, 1],['float32x3', null, 1, 1, 1],['float32x4', null, 1, 1, 1],['uint32', null, 1, 1, 1],['uint32x2', null, 1, 1, 1],['uint32x3', null, 1, 1, 1],['uint32x4', null, 1, 1, 1],['sint32', null, 1, 1, 1],['sint32x2', null, 1, 1, 1],['sint32x3', null, 1, 1, 1],['sint32x4', null, 1, 1, 1],['unorm1010102', null, 1, 1, 1],['unorm8x4-bgra', null, 1, 1, 1],],
              variantSize32: 1,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 1,
            })
            , 1, 1],['offset', _liftFlatU64, 8, 8],['shaderLocation', _liftFlatU32, 4, 4],], size32: 24, align32: 8 }),
            elemAlign32: 8,
            elemSize32: 24,
            typedArray: undefined,
          }), 8, 4],], size32: 24, align32: 8 }), 24, 8, 5, ['i64','i32','i32','i32','i32'] ],
          ],
          variantSize32: 32,
          variantAlign32: 8,
          variantPayloadOffset32: 8,
          variantFlatCount: 6,
          variantPayloadFlatTypes: ['i64','i32','i32','i32','i32'],
        })
        ,
        elemAlign32: 8,
        elemSize32: 32,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['module', _liftFlatBorrow.bind(null, 12), 4, 4],['entryPoint', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['constants', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatOwn({
        componentIdx: 0,
        classNameFn: () => RecordGpuPipelineConstantValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable13[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable13.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(RecordGpuPipelineConstantValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable13.delete(rep);
          }
          rscTableRemove(handleTable13, handle);
          return resourceObj;
        }
        ,
      })
      , 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],], size32: 36, align32: 4 }), 36, 4],['primitive', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['topology', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['point-list', null, 1, 1, 1],['line-list', null, 1, 1, 1],['line-strip', null, 1, 1, 1],['triangle-list', null, 1, 1, 1],['triangle-strip', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stripIndexFormat', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['uint16', null, 1, 1, 1],['uint32', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['frontFace', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['ccw', null, 1, 1, 1],['cw', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['cullMode', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['none', null, 1, 1, 1],['front', null, 1, 1, 1],['back', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['unclippedDepth', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 10, align32: 1 }), 10, 1, 10, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 11,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 11,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    , 11, 1],['depthStencil', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['format', 
      _liftFlatEnum({
        caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1],['depthWriteEnabled', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthCompare', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilFront', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['compare', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['failOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['depthFailOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['passOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],], size32: 8, align32: 1 }), 8, 1, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
        ],
        variantSize32: 9,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 9,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
      })
      , 9, 1],['stencilBack', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['compare', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['failOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['depthFailOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['passOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],], size32: 8, align32: 1 }), 8, 1, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
        ],
        variantSize32: 9,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 9,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
      })
      , 9, 1],['stencilReadMask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['stencilWriteMask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['depthBias', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatS32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['depthBiasSlopeScale', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],['depthBiasClamp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],], size32: 64, align32: 4 }), 64, 4, null, null ],
      ],
      variantSize32: 68,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    , 68, 4],['multisample', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['count', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['mask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['alphaToCoverageEnabled', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 20, align32: 4 }), 20, 4, 6, ['i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 24,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 7,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32'],
    })
    , 24, 4],['fragment', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['targets', _liftFlatList({
        elemLiftFn: 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['format', 
          _liftFlatEnum({
            caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1],['blend', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', _liftFlatRecord({ fieldMetas: [['color', _liftFlatRecord({ fieldMetas: [['operation', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['add', null, 1, 1, 1],['subtract', null, 1, 1, 1],['reverse-subtract', null, 1, 1, 1],['min', null, 1, 1, 1],['max', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['srcFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['dstFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],], size32: 6, align32: 1 }), 6, 1],['alpha', _liftFlatRecord({ fieldMetas: [['operation', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['add', null, 1, 1, 1],['subtract', null, 1, 1, 1],['reverse-subtract', null, 1, 1, 1],['min', null, 1, 1, 1],['max', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['srcFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['dstFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],], size32: 6, align32: 1 }), 6, 1],], size32: 12, align32: 1 }), 12, 1, 12, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
            ],
            variantSize32: 13,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 13,
            variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'],
          })
          , 13, 1],['writeMask', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', _liftFlatFlags({ names: ['red','green','blue','alpha','all'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          })
          , 2, 1],], size32: 16, align32: 1 }), 16, 1, 16, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
          ],
          variantSize32: 17,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: null,
          variantPayloadFlatTypes: null,
        })
        ,
        elemAlign32: 1,
        elemSize32: 17,
        typedArray: undefined,
      }), 8, 4],['module', _liftFlatBorrow.bind(null, 12), 4, 4],['entryPoint', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['constants', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatOwn({
          componentIdx: 0,
          classNameFn: () => RecordGpuPipelineConstantValue,
          createResourceFn: 
          (handle) => {
            const rep = handleTable13[(handle << 1) + 1] & ~T_FLAG;
            let resourceObj = captureTable13.get(rep);
            if (!resourceObj) {
              resourceObj = Object.create(RecordGpuPipelineConstantValue.prototype);
              Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
              Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
            } else {
              captureTable13.delete(rep);
            }
            rscTableRemove(handleTable13, handle);
            return resourceObj;
          }
          ,
        })
        , 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],], size32: 32, align32: 4 }), 32, 4, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 36,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 9,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    , 36, 4],['layout', _liftFlatVariant({
      caseMetas: [['specific', _liftFlatBorrow.bind(null, 11), 4, 4, 1, ['i32']],['auto', null, 0, 0, 0, []],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    } ), 8, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 196, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuRenderPipeline(obj) {
        if (!(obj instanceof GpuRenderPipeline)) {
          throw new TypeError('Resource error: Not a valid \"GpuRenderPipeline\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt14;
          captureTable14.set(rep, obj);
          handle = rscTableCreateOwn(handleTable14, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline66,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 66,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline66.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatRecord({ fieldMetas: [['vertex', _liftFlatRecord({ fieldMetas: [['buffers', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['arrayStride', _liftFlatU64, 8, 8],['stepMode', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', 
            _liftFlatEnum({
              caseMetas: [['vertex', null, 1, 1, 1],['instance', null, 1, 1, 1],],
              variantSize32: 1,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 1,
            })
            , 1, 1, 1, ['i32'] ],
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          })
          , 2, 1],['attributes', _liftFlatList({
            elemLiftFn: _liftFlatRecord({ fieldMetas: [['format', 
            _liftFlatEnum({
              caseMetas: [['uint8', null, 1, 1, 1],['uint8x2', null, 1, 1, 1],['uint8x4', null, 1, 1, 1],['sint8', null, 1, 1, 1],['sint8x2', null, 1, 1, 1],['sint8x4', null, 1, 1, 1],['unorm8', null, 1, 1, 1],['unorm8x2', null, 1, 1, 1],['unorm8x4', null, 1, 1, 1],['snorm8', null, 1, 1, 1],['snorm8x2', null, 1, 1, 1],['snorm8x4', null, 1, 1, 1],['uint16', null, 1, 1, 1],['uint16x2', null, 1, 1, 1],['uint16x4', null, 1, 1, 1],['sint16', null, 1, 1, 1],['sint16x2', null, 1, 1, 1],['sint16x4', null, 1, 1, 1],['unorm16', null, 1, 1, 1],['unorm16x2', null, 1, 1, 1],['unorm16x4', null, 1, 1, 1],['snorm16', null, 1, 1, 1],['snorm16x2', null, 1, 1, 1],['snorm16x4', null, 1, 1, 1],['float16', null, 1, 1, 1],['float16x2', null, 1, 1, 1],['float16x4', null, 1, 1, 1],['float32', null, 1, 1, 1],['float32x2', null, 1, 1, 1],['float32x3', null, 1, 1, 1],['float32x4', null, 1, 1, 1],['uint32', null, 1, 1, 1],['uint32x2', null, 1, 1, 1],['uint32x3', null, 1, 1, 1],['uint32x4', null, 1, 1, 1],['sint32', null, 1, 1, 1],['sint32x2', null, 1, 1, 1],['sint32x3', null, 1, 1, 1],['sint32x4', null, 1, 1, 1],['unorm1010102', null, 1, 1, 1],['unorm8x4-bgra', null, 1, 1, 1],],
              variantSize32: 1,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 1,
            })
            , 1, 1],['offset', _liftFlatU64, 8, 8],['shaderLocation', _liftFlatU32, 4, 4],], size32: 24, align32: 8 }),
            elemAlign32: 8,
            elemSize32: 24,
            typedArray: undefined,
          }), 8, 4],], size32: 24, align32: 8 }), 24, 8, 5, ['i64','i32','i32','i32','i32'] ],
          ],
          variantSize32: 32,
          variantAlign32: 8,
          variantPayloadOffset32: 8,
          variantFlatCount: 6,
          variantPayloadFlatTypes: ['i64','i32','i32','i32','i32'],
        })
        ,
        elemAlign32: 8,
        elemSize32: 32,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['module', _liftFlatBorrow.bind(null, 12), 4, 4],['entryPoint', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['constants', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatOwn({
        componentIdx: 0,
        classNameFn: () => RecordGpuPipelineConstantValue,
        createResourceFn: 
        (handle) => {
          const rep = handleTable13[(handle << 1) + 1] & ~T_FLAG;
          let resourceObj = captureTable13.get(rep);
          if (!resourceObj) {
            resourceObj = Object.create(RecordGpuPipelineConstantValue.prototype);
            Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
            Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
          } else {
            captureTable13.delete(rep);
          }
          rscTableRemove(handleTable13, handle);
          return resourceObj;
        }
        ,
      })
      , 4, 4, 1, ['i32'] ],
      ],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 8, 4],], size32: 36, align32: 4 }), 36, 4],['primitive', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['topology', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['point-list', null, 1, 1, 1],['line-list', null, 1, 1, 1],['line-strip', null, 1, 1, 1],['triangle-list', null, 1, 1, 1],['triangle-strip', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stripIndexFormat', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['uint16', null, 1, 1, 1],['uint32', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['frontFace', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['ccw', null, 1, 1, 1],['cw', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['cullMode', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['none', null, 1, 1, 1],['front', null, 1, 1, 1],['back', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['unclippedDepth', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 10, align32: 1 }), 10, 1, 10, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 11,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 11,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    , 11, 1],['depthStencil', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['format', 
      _liftFlatEnum({
        caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1],['depthWriteEnabled', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['depthCompare', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['stencilFront', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['compare', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['failOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['depthFailOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['passOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],], size32: 8, align32: 1 }), 8, 1, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
        ],
        variantSize32: 9,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 9,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
      })
      , 9, 1],['stencilBack', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatRecord({ fieldMetas: [['compare', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['never', null, 1, 1, 1],['less', null, 1, 1, 1],['equal', null, 1, 1, 1],['less-equal', null, 1, 1, 1],['greater', null, 1, 1, 1],['not-equal', null, 1, 1, 1],['greater-equal', null, 1, 1, 1],['always', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['failOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['depthFailOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],['passOp', 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', 
          _liftFlatEnum({
            caseMetas: [['keep', null, 1, 1, 1],['zero', null, 1, 1, 1],['replace', null, 1, 1, 1],['invert', null, 1, 1, 1],['increment-clamp', null, 1, 1, 1],['decrement-clamp', null, 1, 1, 1],['increment-wrap', null, 1, 1, 1],['decrement-wrap', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1, 1, ['i32'] ],
          ],
          variantSize32: 2,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 2,
          variantPayloadFlatTypes: ['i32'],
        })
        , 2, 1],], size32: 8, align32: 1 }), 8, 1, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
        ],
        variantSize32: 9,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 9,
        variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
      })
      , 9, 1],['stencilReadMask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['stencilWriteMask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['depthBias', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatS32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['depthBiasSlopeScale', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],['depthBiasClamp', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFloat32, 4, 4, 1, ['f32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['f32'],
      })
      , 8, 4],], size32: 64, align32: 4 }), 64, 4, null, null ],
      ],
      variantSize32: 68,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    , 68, 4],['multisample', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['count', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['mask', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['alphaToCoverageEnabled', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatBool, 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 20, align32: 4 }), 20, 4, 6, ['i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 24,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 7,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32'],
    })
    , 24, 4],['fragment', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['targets', _liftFlatList({
        elemLiftFn: 
        _liftFlatOption({
          caseMetas: [
          ['none', null, 0, 0, 0, [] ],
          ['some', _liftFlatRecord({ fieldMetas: [['format', 
          _liftFlatEnum({
            caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
          })
          , 1, 1],['blend', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', _liftFlatRecord({ fieldMetas: [['color', _liftFlatRecord({ fieldMetas: [['operation', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['add', null, 1, 1, 1],['subtract', null, 1, 1, 1],['reverse-subtract', null, 1, 1, 1],['min', null, 1, 1, 1],['max', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['srcFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['dstFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],], size32: 6, align32: 1 }), 6, 1],['alpha', _liftFlatRecord({ fieldMetas: [['operation', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['add', null, 1, 1, 1],['subtract', null, 1, 1, 1],['reverse-subtract', null, 1, 1, 1],['min', null, 1, 1, 1],['max', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['srcFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],['dstFactor', 
            _liftFlatOption({
              caseMetas: [
              ['none', null, 0, 0, 0, [] ],
              ['some', 
              _liftFlatEnum({
                caseMetas: [['zero', null, 1, 1, 1],['one', null, 1, 1, 1],['src', null, 1, 1, 1],['one-minus-src', null, 1, 1, 1],['src-alpha', null, 1, 1, 1],['one-minus-src-alpha', null, 1, 1, 1],['dst', null, 1, 1, 1],['one-minus-dst', null, 1, 1, 1],['dst-alpha', null, 1, 1, 1],['one-minus-dst-alpha', null, 1, 1, 1],['src-alpha-saturated', null, 1, 1, 1],['constant', null, 1, 1, 1],['one-minus-constant', null, 1, 1, 1],['src1', null, 1, 1, 1],['one-minus-src1', null, 1, 1, 1],['src1-alpha', null, 1, 1, 1],['one-minus-src1-alpha', null, 1, 1, 1],],
                variantSize32: 1,
                variantAlign32: 1,
                variantPayloadOffset32: 1,
                variantFlatCount: 1,
              })
              , 1, 1, 1, ['i32'] ],
              ],
              variantSize32: 2,
              variantAlign32: 1,
              variantPayloadOffset32: 1,
              variantFlatCount: 2,
              variantPayloadFlatTypes: ['i32'],
            })
            , 2, 1],], size32: 6, align32: 1 }), 6, 1],], size32: 12, align32: 1 }), 12, 1, 12, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
            ],
            variantSize32: 13,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 13,
            variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'],
          })
          , 13, 1],['writeMask', 
          _liftFlatOption({
            caseMetas: [
            ['none', null, 0, 0, 0, [] ],
            ['some', _liftFlatFlags({ names: ['red','green','blue','alpha','all'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            variantPayloadFlatTypes: ['i32'],
          })
          , 2, 1],], size32: 16, align32: 1 }), 16, 1, 16, ['i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32','i32'] ],
          ],
          variantSize32: 17,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: null,
          variantPayloadFlatTypes: null,
        })
        ,
        elemAlign32: 1,
        elemSize32: 17,
        typedArray: undefined,
      }), 8, 4],['module', _liftFlatBorrow.bind(null, 12), 4, 4],['entryPoint', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['constants', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatOwn({
          componentIdx: 0,
          classNameFn: () => RecordGpuPipelineConstantValue,
          createResourceFn: 
          (handle) => {
            const rep = handleTable13[(handle << 1) + 1] & ~T_FLAG;
            let resourceObj = captureTable13.get(rep);
            if (!resourceObj) {
              resourceObj = Object.create(RecordGpuPipelineConstantValue.prototype);
              Object.defineProperty(resourceObj, symbolRscHandle, { writable: true, value: handle });
              Object.defineProperty(resourceObj, symbolRscRep, { writable: true, value: rep });
            } else {
              captureTable13.delete(rep);
            }
            rscTableRemove(handleTable13, handle);
            return resourceObj;
          }
          ,
        })
        , 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],], size32: 32, align32: 4 }), 32, 4, 8, ['i32','i32','i32','i32','i32','i32','i32','i32'] ],
      ],
      variantSize32: 36,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 9,
      variantPayloadFlatTypes: ['i32','i32','i32','i32','i32','i32','i32','i32'],
    })
    , 36, 4],['layout', _liftFlatVariant({
      caseMetas: [['specific', _liftFlatBorrow.bind(null, 11), 4, 4, 1, ['i32']],['auto', null, 0, 0, 0, []],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    } ), 8, 4],['label', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],], size32: 196, align32: 4 })],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuRenderPipeline(obj) {
        if (!(obj instanceof GpuRenderPipeline)) {
          throw new TypeError('Resource error: Not a valid \"GpuRenderPipeline\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt14;
          captureTable14.set(rep, obj);
          handle = rscTableCreateOwn(handleTable14, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline66,
  },
  );
  let trampoline67 = _trampoline67.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 67,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline67.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 12, align32: 4 }), 12, 4, 3, ['i32','i32','i32'] ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
      variantPayloadFlatTypes: ['i32','i32','i32'],
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuCommandEncoder(obj) {
        if (!(obj instanceof GpuCommandEncoder)) {
          throw new TypeError('Resource error: Not a valid \"GpuCommandEncoder\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt4;
          captureTable4.set(rep, obj);
          handle = rscTableCreateOwn(handleTable4, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline67,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 67,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline67.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 3),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 12, align32: 4 }), 12, 4, 3, ['i32','i32','i32'] ],
      ],
      variantSize32: 16,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 4,
      variantPayloadFlatTypes: ['i32','i32','i32'],
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuCommandEncoder(obj) {
        if (!(obj instanceof GpuCommandEncoder)) {
          throw new TypeError('Resource error: Not a valid \"GpuCommandEncoder\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt4;
          captureTable4.set(rep, obj);
          handle = rscTableCreateOwn(handleTable4, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline67,
  },
  );
  let trampoline68 = _trampoline68.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 68,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline68.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 9),_liftFlatList({
      elemLiftFn: _liftFlatBorrow.bind(null, 8),
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    })],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline68,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 68,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline68.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 9),_liftFlatList({
      elemLiftFn: _liftFlatBorrow.bind(null, 8),
      elemAlign32: 4,
      elemSize32: 4,
      typedArray: undefined,
    })],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline68,
  },
  );
  let trampoline69 = _trampoline69.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 69,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline69.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 15),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['format', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['dimension', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['d1', null, 1, 1, 1],['d2', null, 1, 1, 1],['d2-array', null, 1, 1, 1],['cube', null, 1, 1, 1],['cube-array', null, 1, 1, 1],['d3', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['usage', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFlags({ names: ['copySrc','copyDst','textureBinding','storageBinding','renderAttachment','transientAttachment'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['aspect', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['all', null, 1, 1, 1],['stencil-only', null, 1, 1, 1],['depth-only', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['baseMipLevel', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['mipLevelCount', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['baseArrayLayer', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['arrayLayerCount', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['swizzle', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 64, align32: 4 }), 64, 4, null, null ],
      ],
      variantSize32: 68,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuTextureView(obj) {
        if (!(obj instanceof GpuTextureView)) {
          throw new TypeError('Resource error: Not a valid \"GpuTextureView\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline69,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 69,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline69.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 15),
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['format', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['dimension', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['d1', null, 1, 1, 1],['d2', null, 1, 1, 1],['d2-array', null, 1, 1, 1],['cube', null, 1, 1, 1],['cube-array', null, 1, 1, 1],['d3', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['usage', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatFlags({ names: ['copySrc','copyDst','textureBinding','storageBinding','renderAttachment','transientAttachment'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['aspect', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['all', null, 1, 1, 1],['stencil-only', null, 1, 1, 1],['depth-only', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],['baseMipLevel', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['mipLevelCount', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['baseArrayLayer', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['arrayLayerCount', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatU32, 4, 4, 1, ['i32'] ],
        ],
        variantSize32: 8,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 8, 4],['swizzle', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],['label', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', _liftFlatStringAny, 8, 4, 2, ['i32','i32'] ],
        ],
        variantSize32: 12,
        variantAlign32: 4,
        variantPayloadOffset32: 4,
        variantFlatCount: 3,
        variantPayloadFlatTypes: ['i32','i32'],
      })
      , 12, 4],], size32: 64, align32: 4 }), 64, 4, null, null ],
      ],
      variantSize32: 68,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: null,
      variantPayloadFlatTypes: null,
    })
    ],
    resultLowerFns: [_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_GpuTextureView(obj) {
        if (!(obj instanceof GpuTextureView)) {
          throw new TypeError('Resource error: Not a valid \"GpuTextureView\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep, obj);
          handle = rscTableCreateOwn(handleTable5, rep);
        }
        return handle;
      }
      ,
    })],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline69,
  },
  );
  
  const trampoline70 = new WebAssembly.Suspending(_suspendingImport(0, streamWrite.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 0,
  }
  )));
  
  const trampoline71 = new WebAssembly.Suspending(_suspendingImport(0, streamRead.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 0,
  }
  )));
  
  
  const trampoline72 = new WebAssembly.Suspending(_suspendingImport(0, streamWrite.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 1,
  }
  )));
  
  const trampoline73 = new WebAssembly.Suspending(_suspendingImport(0, streamRead.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 1,
  }
  )));
  
  
  const trampoline74 = new WebAssembly.Suspending(_suspendingImport(0, streamWrite.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 2,
  }
  )));
  
  const trampoline75 = new WebAssembly.Suspending(_suspendingImport(0, streamRead.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 2,
  }
  )));
  
  
  const trampoline76 = new WebAssembly.Suspending(_suspendingImport(0, streamWrite.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: undefined,
    getReallocFn: undefined,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 3,
  }
  )));
  
  const trampoline77 = new WebAssembly.Suspending(_suspendingImport(0, streamRead.bind(
  null,
  {
    componentIdx: 0,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
    reallocIdx: 0,
    getReallocFn: () => realloc0,
    stringEncoding: 'utf8',
    isAsync: true,
    streamTableIdx: 3,
  }
  )));
  
  let trampoline78 = _trampoline78.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 78,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline78.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17),_liftFlatRecord({ fieldMetas: [['device', _liftFlatBorrow.bind(null, 3), 4, 4],['format', 
    _liftFlatEnum({
      caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['usage', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatFlags({ names: ['copySrc','copyDst','textureBinding','storageBinding','renderAttachment','transientAttachment'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],['viewFormats', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: 
        _liftFlatEnum({
          caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        ,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['colorSpace', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', 
      _liftFlatEnum({
        caseMetas: [['srgb', null, 1, 1, 1],['display-p3', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],['toneMapping', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['mode', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['standard', null, 1, 1, 1],['extended', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 2, align32: 1 }), 2, 1, 2, ['i32','i32'] ],
      ],
      variantSize32: 3,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 3, 1],['alphaMode', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', 
      _liftFlatEnum({
        caseMetas: [['opaque', null, 1, 1, 1],['premultiplied', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],], size32: 28, align32: 4 })],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline78,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 78,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline78.manuallyAsync,
    paramLiftFns: [_liftFlatBorrow.bind(null, 17),_liftFlatRecord({ fieldMetas: [['device', _liftFlatBorrow.bind(null, 3), 4, 4],['format', 
    _liftFlatEnum({
      caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1],['usage', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatFlags({ names: ['copySrc','copyDst','textureBinding','storageBinding','renderAttachment','transientAttachment'], size32: 1, align32: 1, intSizeBytes: 1 }), 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],['viewFormats', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatList({
        elemLiftFn: 
        _liftFlatEnum({
          caseMetas: [['r8unorm', null, 1, 1, 1],['r8snorm', null, 1, 1, 1],['r8uint', null, 1, 1, 1],['r8sint', null, 1, 1, 1],['r16unorm', null, 1, 1, 1],['r16snorm', null, 1, 1, 1],['r16uint', null, 1, 1, 1],['r16sint', null, 1, 1, 1],['r16float', null, 1, 1, 1],['rg8unorm', null, 1, 1, 1],['rg8snorm', null, 1, 1, 1],['rg8uint', null, 1, 1, 1],['rg8sint', null, 1, 1, 1],['r32uint', null, 1, 1, 1],['r32sint', null, 1, 1, 1],['r32float', null, 1, 1, 1],['rg16unorm', null, 1, 1, 1],['rg16snorm', null, 1, 1, 1],['rg16uint', null, 1, 1, 1],['rg16sint', null, 1, 1, 1],['rg16float', null, 1, 1, 1],['rgba8unorm', null, 1, 1, 1],['rgba8unorm-srgb', null, 1, 1, 1],['rgba8snorm', null, 1, 1, 1],['rgba8uint', null, 1, 1, 1],['rgba8sint', null, 1, 1, 1],['bgra8unorm', null, 1, 1, 1],['bgra8unorm-srgb', null, 1, 1, 1],['rgb9e5ufloat', null, 1, 1, 1],['rgb10a2uint', null, 1, 1, 1],['rgb10a2unorm', null, 1, 1, 1],['rg11b10ufloat', null, 1, 1, 1],['rg32uint', null, 1, 1, 1],['rg32sint', null, 1, 1, 1],['rg32float', null, 1, 1, 1],['rgba16unorm', null, 1, 1, 1],['rgba16snorm', null, 1, 1, 1],['rgba16uint', null, 1, 1, 1],['rgba16sint', null, 1, 1, 1],['rgba16float', null, 1, 1, 1],['rgba32uint', null, 1, 1, 1],['rgba32sint', null, 1, 1, 1],['rgba32float', null, 1, 1, 1],['stencil8', null, 1, 1, 1],['depth16unorm', null, 1, 1, 1],['depth24plus', null, 1, 1, 1],['depth24plus-stencil8', null, 1, 1, 1],['depth32float', null, 1, 1, 1],['depth32float-stencil8', null, 1, 1, 1],['bc1-rgba-unorm', null, 1, 1, 1],['bc1-rgba-unorm-srgb', null, 1, 1, 1],['bc2-rgba-unorm', null, 1, 1, 1],['bc2-rgba-unorm-srgb', null, 1, 1, 1],['bc3-rgba-unorm', null, 1, 1, 1],['bc3-rgba-unorm-srgb', null, 1, 1, 1],['bc4-r-unorm', null, 1, 1, 1],['bc4-r-snorm', null, 1, 1, 1],['bc5-rg-unorm', null, 1, 1, 1],['bc5-rg-snorm', null, 1, 1, 1],['bc6h-rgb-ufloat', null, 1, 1, 1],['bc6h-rgb-float', null, 1, 1, 1],['bc7-rgba-unorm', null, 1, 1, 1],['bc7-rgba-unorm-srgb', null, 1, 1, 1],['etc2-rgb8unorm', null, 1, 1, 1],['etc2-rgb8unorm-srgb', null, 1, 1, 1],['etc2-rgb8a1unorm', null, 1, 1, 1],['etc2-rgb8a1unorm-srgb', null, 1, 1, 1],['etc2-rgba8unorm', null, 1, 1, 1],['etc2-rgba8unorm-srgb', null, 1, 1, 1],['eac-r11unorm', null, 1, 1, 1],['eac-r11snorm', null, 1, 1, 1],['eac-rg11unorm', null, 1, 1, 1],['eac-rg11snorm', null, 1, 1, 1],['astc4x4-unorm', null, 1, 1, 1],['astc4x4-unorm-srgb', null, 1, 1, 1],['astc5x4-unorm', null, 1, 1, 1],['astc5x4-unorm-srgb', null, 1, 1, 1],['astc5x5-unorm', null, 1, 1, 1],['astc5x5-unorm-srgb', null, 1, 1, 1],['astc6x5-unorm', null, 1, 1, 1],['astc6x5-unorm-srgb', null, 1, 1, 1],['astc6x6-unorm', null, 1, 1, 1],['astc6x6-unorm-srgb', null, 1, 1, 1],['astc8x5-unorm', null, 1, 1, 1],['astc8x5-unorm-srgb', null, 1, 1, 1],['astc8x6-unorm', null, 1, 1, 1],['astc8x6-unorm-srgb', null, 1, 1, 1],['astc8x8-unorm', null, 1, 1, 1],['astc8x8-unorm-srgb', null, 1, 1, 1],['astc10x5-unorm', null, 1, 1, 1],['astc10x5-unorm-srgb', null, 1, 1, 1],['astc10x6-unorm', null, 1, 1, 1],['astc10x6-unorm-srgb', null, 1, 1, 1],['astc10x8-unorm', null, 1, 1, 1],['astc10x8-unorm-srgb', null, 1, 1, 1],['astc10x10-unorm', null, 1, 1, 1],['astc10x10-unorm-srgb', null, 1, 1, 1],['astc12x10-unorm', null, 1, 1, 1],['astc12x10-unorm-srgb', null, 1, 1, 1],['astc12x12-unorm', null, 1, 1, 1],['astc12x12-unorm-srgb', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        ,
        elemAlign32: 1,
        elemSize32: 1,
        typedArray: undefined,
      }), 8, 4, 2, ['i32','i32'] ],
      ],
      variantSize32: 12,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 12, 4],['colorSpace', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', 
      _liftFlatEnum({
        caseMetas: [['srgb', null, 1, 1, 1],['display-p3', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],['toneMapping', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', _liftFlatRecord({ fieldMetas: [['mode', 
      _liftFlatOption({
        caseMetas: [
        ['none', null, 0, 0, 0, [] ],
        ['some', 
        _liftFlatEnum({
          caseMetas: [['standard', null, 1, 1, 1],['extended', null, 1, 1, 1],],
          variantSize32: 1,
          variantAlign32: 1,
          variantPayloadOffset32: 1,
          variantFlatCount: 1,
        })
        , 1, 1, 1, ['i32'] ],
        ],
        variantSize32: 2,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 2,
        variantPayloadFlatTypes: ['i32'],
      })
      , 2, 1],], size32: 2, align32: 1 }), 2, 1, 2, ['i32','i32'] ],
      ],
      variantSize32: 3,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 3,
      variantPayloadFlatTypes: ['i32','i32'],
    })
    , 3, 1],['alphaMode', 
    _liftFlatOption({
      caseMetas: [
      ['none', null, 0, 0, 0, [] ],
      ['some', 
      _liftFlatEnum({
        caseMetas: [['opaque', null, 1, 1, 1],['premultiplied', null, 1, 1, 1],],
        variantSize32: 1,
        variantAlign32: 1,
        variantPayloadOffset32: 1,
        variantFlatCount: 1,
      })
      , 1, 1, 1, ['i32'] ],
      ],
      variantSize32: 2,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 2,
      variantPayloadFlatTypes: ['i32'],
    })
    , 2, 1],], size32: 28, align32: 4 })],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline78,
  },
  );
  let trampoline79 = _trampoline79.manuallyAsync ? new WebAssembly.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 79,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline79.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline79,
  },
  ))) : _lowerImportBackwardsCompat.bind(
  null,
  {
    trampolineIdx: 79,
    componentIdx: 0,
    isAsync: false,
    isManualAsync: _trampoline79.manuallyAsync,
    paramLiftFns: [_liftFlatStringAny],
    resultLowerFns: [],
    hasResultPointer: false,
    funcTypeIsAsync: false,
    getCallbackFn: () => null,
    getPostReturnFn: () => null,
    isCancellable: false,
    memoryIdx: 0,
    stringEncoding: 'utf8',
    getMemoryFn: () => memory0,
    getReallocFn: undefined,
    importFn: _trampoline79,
  },
  );
  
  const trampoline80 = waitableSetPoll.bind(
  null,
  {
    componentIdx: 0,
    isAsync: false,
    isCancellable: false,
    memoryIdx: 0,
    getMemoryFn: () => memory0,
  }
  );
  
  
  const $init = (() => {
    let gen = (function* _initGenerator () {
      const module0 = fetchCompile(new URL('./triangle.component.core.wasm', import.meta.url));
      const module1 = base64Compile('AGFzbQEAAAABWApgAn9/AX9gAX8Bf2AFf39/f38Bf2AIf39/f39/f38Bf2AJf39/f39/f39/AX9gA39/fwBgA39/fwF/YA9/f39/f39/f39/f39/f38AYAJ/fwBgAn9/AX8DFhUAAAECAwQBAgUBBgYGBgYGBgYHCAkEBQFwARUVB2sWATAAAAExAAEBMgACATMAAwE0AAQBNQAFATYABgE3AAcBOAAIATkACQIxMAAKAjExAAsCMTIADAIxMwANAjE0AA4CMTUADwIxNgAQAjE3ABECMTgAEgIxOQATAjIwABQIJGltcG9ydHMBAArJAhULACAAIAFBABEAAAsLACAAIAFBAREAAAsJACAAQQIRAQALEQAgACABIAIgAyAEQQMRAgALFwAgACABIAIgAyAEIAUgBiAHQQQRAwALGQAgACABIAIgAyAEIAUgBiAHIAhBBREEAAsJACAAQQYRAQALEQAgACABIAIgAyAEQQcRAgALDQAgACABIAJBCBEFAAsJACAAQQkRAQALDQAgACABIAJBChEGAAsNACAAIAEgAkELEQYACw0AIAAgASACQQwRBgALDQAgACABIAJBDREGAAsNACAAIAEgAkEOEQYACw0AIAAgASACQQ8RBgALDQAgACABIAJBEBEGAAsNACAAIAEgAkEREQYACyUAIAAgASACIAMgBCAFIAYgByAIIAkgCiALIAwgDSAOQRIRBwALCwAgACABQRMRCAALCwAgACABQRQRCQALAC8JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDXdpdC1jb21wb25lbnQHMC4yNDQuMA');
      const module2 = base64Compile('AGFzbQEAAAABWApgAn9/AX9gAX8Bf2AFf39/f38Bf2AIf39/f39/f38Bf2AJf39/f39/f39/AX9gA39/fwBgA39/fwF/YA9/f39/f39/f39/f39/f38AYAJ/fwBgAn9/AX8ChAEWAAEwAAAAATEAAAABMgABAAEzAAIAATQAAwABNQAEAAE2AAEAATcAAgABOAAFAAE5AAEAAjEwAAYAAjExAAYAAjEyAAYAAjEzAAYAAjE0AAYAAjE1AAYAAjE2AAYAAjE3AAYAAjE4AAcAAjE5AAgAAjIwAAkACCRpbXBvcnRzAXABFRUJGwEAQQALFQABAgMEBQYHCAkKCwwNDg8QERITFAAvCXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQ13aXQtY29tcG9uZW50BzAuMjQ0LjA');
      const instanceFlags0 = new WebAssembly.Global({ value: "i32", mutable: true }, 1);
      INSTANCE_FLAGS.set(0, instanceFlags0);
      let _initTaskID0;
      try {
        
        [, _initTaskID0] = createNewCurrentTask({
          componentIdx: 0,
          isAsync: false,
          callingWasmExport: true,
          entryFnName: '<initialize>',
        });
        _setGlobalCurrentTaskMeta({ componentIdx: 0, taskID: _initTaskID0});
        
        ({ exports: exports0 } = yield instantiateCore(yield module1));
        ({ exports: exports1 } = yield instantiateCore(yield module0, {
          $root: {
            '[context-get-0]': contextGet.bind(null, { componentIdx: 0, slot: 0 }),
            '[context-set-0]': contextSet.bind(null, { componentIdx: 0, slot: 0 }),
            '[subtask-cancel]': trampoline19,
            '[subtask-drop]': _guardMayLeave(0, trampoline55),
            '[waitable-join]': _guardMayLeave(0, trampoline57),
            '[waitable-set-drop]': _guardMayLeave(0, trampoline56),
            '[waitable-set-new]': _guardMayLeave(0, trampoline58),
            '[waitable-set-poll]': exports0['20'],
            print: exports0['19'],
          },
          '[export]$root': {
            '[task-cancel]': _guardMayLeave(0, trampoline59),
            '[task-return]start': _guardMayLeave(0, trampoline54),
          },
          'wasi-gfx:surface/surface-webgpu@0.2.0': {
            '[constructor]context': trampoline16,
            '[method]context.configure': exports0['18'],
            '[method]context.get-current-texture': trampoline17,
            '[method]context.present': trampoline18,
            '[resource-drop]context': _guardMayLeave(0, trampoline31),
          },
          'wasi-gfx:surface/surface@0.2.0': {
            '[async-lower][stream-read-0][method]surface.on-frame': exports0['13'],
            '[async-lower][stream-read-0][method]surface.on-key-up': exports0['17'],
            '[async-lower][stream-read-0][method]surface.on-pointer-up': exports0['15'],
            '[async-lower][stream-read-0][method]surface.on-resize': exports0['11'],
            '[async-lower][stream-write-0][method]surface.on-frame': exports0['12'],
            '[async-lower][stream-write-0][method]surface.on-key-up': exports0['16'],
            '[async-lower][stream-write-0][method]surface.on-pointer-up': exports0['14'],
            '[async-lower][stream-write-0][method]surface.on-resize': exports0['10'],
            '[constructor]surface': trampoline8,
            '[method]surface.on-frame': trampoline10,
            '[method]surface.on-key-down': trampoline15,
            '[method]surface.on-key-up': trampoline14,
            '[method]surface.on-pointer-down': trampoline12,
            '[method]surface.on-pointer-move': trampoline13,
            '[method]surface.on-pointer-up': trampoline11,
            '[method]surface.on-resize': trampoline9,
            '[resource-drop]surface': _guardMayLeave(0, trampoline33),
            '[stream-cancel-read-0][method]surface.on-frame': trampoline40,
            '[stream-cancel-read-0][method]surface.on-key-up': trampoline50,
            '[stream-cancel-read-0][method]surface.on-pointer-up': trampoline45,
            '[stream-cancel-read-0][method]surface.on-resize': trampoline35,
            '[stream-cancel-write-0][method]surface.on-frame': trampoline39,
            '[stream-cancel-write-0][method]surface.on-key-up': trampoline49,
            '[stream-cancel-write-0][method]surface.on-pointer-up': trampoline44,
            '[stream-cancel-write-0][method]surface.on-resize': trampoline34,
            '[stream-drop-readable-0][method]surface.on-frame': _guardMayLeave(0, trampoline42),
            '[stream-drop-readable-0][method]surface.on-key-up': _guardMayLeave(0, trampoline52),
            '[stream-drop-readable-0][method]surface.on-pointer-up': _guardMayLeave(0, trampoline47),
            '[stream-drop-readable-0][method]surface.on-resize': _guardMayLeave(0, trampoline37),
            '[stream-drop-writable-0][method]surface.on-frame': _guardMayLeave(0, trampoline41),
            '[stream-drop-writable-0][method]surface.on-key-up': _guardMayLeave(0, trampoline51),
            '[stream-drop-writable-0][method]surface.on-pointer-up': _guardMayLeave(0, trampoline46),
            '[stream-drop-writable-0][method]surface.on-resize': _guardMayLeave(0, trampoline36),
            '[stream-new-0][method]surface.on-frame': _guardMayLeave(0, trampoline43),
            '[stream-new-0][method]surface.on-key-up': _guardMayLeave(0, trampoline53),
            '[stream-new-0][method]surface.on-pointer-up': _guardMayLeave(0, trampoline48),
            '[stream-new-0][method]surface.on-resize': _guardMayLeave(0, trampoline38),
          },
          'wasi:webgpu/webgpu@0.3.0-rc.2': {
            '[async-lower][method]gpu-adapter.request-device': exports0['1'],
            '[async-lower][method]gpu.request-adapter': exports0['0'],
            '[method]gpu-command-encoder.begin-render-pass': exports0['2'],
            '[method]gpu-command-encoder.finish': exports0['3'],
            '[method]gpu-device.create-command-encoder': exports0['7'],
            '[method]gpu-device.create-pipeline-layout': exports0['4'],
            '[method]gpu-device.create-render-pipeline': exports0['6'],
            '[method]gpu-device.create-shader-module': exports0['5'],
            '[method]gpu-device.queue': trampoline2,
            '[method]gpu-queue.submit': exports0['8'],
            '[method]gpu-render-pass-encoder.draw': trampoline6,
            '[method]gpu-render-pass-encoder.end': trampoline4,
            '[method]gpu-render-pass-encoder.set-pipeline': trampoline5,
            '[method]gpu-texture.create-view': exports0['9'],
            '[method]gpu.get-preferred-canvas-format': trampoline0,
            '[resource-drop]gpu': _guardMayLeave(0, trampoline27),
            '[resource-drop]gpu-adapter': _guardMayLeave(0, trampoline30),
            '[resource-drop]gpu-command-buffer': _guardMayLeave(0, trampoline21),
            '[resource-drop]gpu-command-encoder': _guardMayLeave(0, trampoline26),
            '[resource-drop]gpu-device': _guardMayLeave(0, trampoline20),
            '[resource-drop]gpu-pipeline-layout': _guardMayLeave(0, trampoline32),
            '[resource-drop]gpu-queue': _guardMayLeave(0, trampoline25),
            '[resource-drop]gpu-render-pass-encoder': _guardMayLeave(0, trampoline29),
            '[resource-drop]gpu-render-pipeline': _guardMayLeave(0, trampoline24),
            '[resource-drop]gpu-shader-module': _guardMayLeave(0, trampoline28),
            '[resource-drop]gpu-texture': _guardMayLeave(0, trampoline22),
            '[resource-drop]gpu-texture-view': _guardMayLeave(0, trampoline23),
            '[resource-drop]record-gpu-pipeline-constant-value': _guardMayLeave(0, trampoline3),
            '[resource-drop]record-option-gpu-size64': _guardMayLeave(0, trampoline1),
            'get-gpu': trampoline7,
          },
        }));
        memory0 = exports1.memory;
        realloc0 = exports1.cabi_realloc;
        
        try {
          realloc0Async = WebAssembly.promising(exports1.cabi_realloc);
        } catch(err) {
          realloc0Async = exports1.cabi_realloc;
        }
        
        ({ exports: exports2 } = yield instantiateCore(yield module2, {
          '': {
            $imports: exports0.$imports,
            '0': trampoline60,
            '1': trampoline61,
            '10': trampoline70,
            '11': trampoline71,
            '12': trampoline72,
            '13': trampoline73,
            '14': trampoline74,
            '15': trampoline75,
            '16': trampoline76,
            '17': trampoline77,
            '18': trampoline78,
            '19': trampoline79,
            '2': trampoline62,
            '20': _guardMayLeave(0, trampoline80),
            '3': trampoline63,
            '4': trampoline64,
            '5': trampoline65,
            '6': trampoline66,
            '7': trampoline67,
            '8': trampoline68,
            '9': trampoline69,
          },
        }));
        
        callback_0 = WebAssembly.promising(exports1['[callback][async-lift]start']);
        callback_0.fnName = "exports1['[callback][async-lift]start']";
        
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
        registerGlobalMemoryForComponent({
          componentIdx: 0,
          memoryIdx: 0,
          memory: memory0,
        });
      } finally {
        
        _clearCurrentTask({ componentIdx: 0, taskID: _initTaskID0});
        clearCurrentTask(0, _initTaskID0);
        
      }
      exports1AsyncLiftStart = WebAssembly.promising(exports1['[async-lift]start']);
    })();
    let promise, resolve, reject;
    function runNext (value) {
      try {
        let done;
        do {
          ({ value, done } = gen.next(value));
        } while (!(value instanceof Promise) && !done);
        if (done) {
          if (resolve) resolve(value);
          else return value;
        }
        if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
        value.then(runNext, reject);
      }
      catch (e) {
        if (reject) reject(e);
        else throw e;
      }
    }
    const maybeSyncReturn = runNext(null);
    return promise || maybeSyncReturn;
  })();
  
  await $init;
  
  export { start,  }
  export const _util = {
    
  }
  
  