"""Linux descendant custody for the native demo; no runtime semantics."""
import ctypes
import errno
import json
import os
import signal
import subprocess
import sys


def prctl(option, value):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(ctypes.c_int(option), ctypes.c_ulong(value),
                  ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def report(error, phase):
    def bounded(value):
        return str(value).encode('utf-16-le', 'surrogatepass')[:192].decode('utf-16-le', 'surrogatepass')

    record = {"event": "demo-worker-failure", "phase": phase, "errors": [{
        "name": bounded(type(error).__name__),
        "code": errno.errorcode.get(getattr(error, "errno", None), ""),
        "message": bounded(error)}]}
    data = (json.dumps(record) + "\n").encode()
    try:
        while data:
            data = data[os.write(4, data):]
    except OSError:
        pass  # Exit status still reports diagnostic delivery failure.


def main():
    if sys.argv[1:] == ["--check"]:
        prctl(36, 1)  # PR_SET_CHILD_SUBREAPER
        prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
        prctl(1, 0)
        print("demo-guardian-capable/v1")
        return 0

    parent, grace, worker, executable, *args = sys.argv[1:]
    if os.getpgrp() != os.getpid() or int(parent) < 2 or not 0 < float(grace) <= 12:
        raise ValueError("Guardian requires its own process group and bounded grace")
    if worker not in ("worker", "native"):
        raise ValueError("Unknown guardian payload kind")
    stopping = False
    acquired = False

    def force_stop(_signal, _frame):
        # Executing inside the anchored group avoids numeric PGID reuse.
        os.kill(0, signal.SIGKILL)

    def stop(_signal=None, _frame=None):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        signal.setitimer(signal.ITIMER_REAL, float(grace))
        if acquired:
            os.kill(0, signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGALRM, force_stop)
    prctl(36, 1)
    prctl(1, signal.SIGTERM)
    if os.getppid() != int(parent):
        stop()

    # No stop handler can run between spawn admission and retaining its PID.
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    child = None
    try:
        if not stopping:
            inherited = [4]
            if worker == "worker":
                inherited.append(int(os.environ["NODE_CHANNEL_FD"]))
            child = subprocess.Popen([executable, *args], pass_fds=inherited,
                                     preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, mask))
            acquired = True
            if worker == "worker":
                os.close(int(os.environ["NODE_CHANNEL_FD"]))
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
    if child is None:
        return 1

    result = 0
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            # Unlike direct-child close, ECHILD includes adopted descendants.
            break
        code = os.waitstatus_to_exitcode(status)
        if code != 0:
            result = 1
            report(RuntimeError("Payload or descendant exited abnormally: " + str(code)), "cleanup")
        if pid == child.pid:
            child.returncode = code
            stop()
    signal.setitimer(signal.ITIMER_REAL, 0)
    return result


try:
    sys.exit(main())
except Exception as error:
    report(error, "initialization")
    if sys.argv[1:] != ["--check"] and os.getpgrp() == os.getpid():
        os.kill(0, signal.SIGKILL)
    sys.exit(1)
