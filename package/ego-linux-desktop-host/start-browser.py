#!/usr/bin/env python3
"""Start a session-local, unprivileged Linux browser on the existing desktop."""
import hashlib
import fcntl
import json
import os
import signal
from pathlib import Path
import socket
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent


def private(path):
    if path.is_symlink():
        raise RuntimeError('Browser state path is a symbolic link')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError('Browser state owner mismatch')
    path.chmod(0o700)
    return path


def listening(path):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.3)
            client.connect(str(path))
        return True
    except OSError:
        return False


def launch(runtime, args, env, config):
    # SDK rounds and the desktop launcher can start simultaneously.
    descriptor = os.open(runtime / 'launch.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError('Unsafe browser launch lock')
        deadline = time.monotonic() + 22
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Another browser launch did not finish')
                time.sleep(0.1)
        destination = runtime / 'runtime.json'
        if destination.is_symlink():
            raise RuntimeError('Unsafe browser runtime metadata')
        if not destination.exists():
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump(config, output)
        else:
            info = destination.stat()
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Unsafe browser runtime metadata')
            if json.loads(destination.read_text()) != config:
                raise RuntimeError('Browser runtime configuration mismatch')
        if listening(runtime / 'bridge.sock'):
            return
        log_fd = os.open(runtime / 'host.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(log_fd, 'ab') as log:
            info = os.fstat(log.fileno())
            if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Unsafe browser log path')
            child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True, close_fds=True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if listening(runtime / 'bridge.sock'):
                return
            status = child.poll()
            if status is not None:
                raise RuntimeError('Browser host exited before readiness (exit ' + str(status) + '); inspect the private host log')
            time.sleep(0.15)
        # Stop only the process group created by this failed startup attempt.
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=1)
        except ProcessLookupError:
            pass
        raise RuntimeError('Browser host did not become ready; inspect the private host log')


def main():
    if os.getuid() == 0:
        raise RuntimeError('Run the browser as an unprivileged desktop user')
    if not os.environ.get('DISPLAY') and not os.environ.get('WAYLAND_DISPLAY'):
        raise RuntimeError('A Linux desktop display is required (X11 or Wayland)')
    os.umask(0o077)
    data_home = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
    profile = Path(os.environ.get('EGO_LINUX_USER_DATA_DIR', str(data_home / 'ego-linux-reference')))
    if not profile.is_absolute():
        raise RuntimeError('EGO_LINUX_USER_DATA_DIR must be absolute')
    user_data = private(profile)
    workspace = Path(os.environ.get('EGO_LINUX_WORKSPACE', str(user_data / 'workspace')))
    if not workspace.is_absolute():
        raise RuntimeError('EGO_LINUX_WORKSPACE must be absolute')
    if 'EGO_LINUX_WORKSPACE' not in os.environ:
        private(workspace)
    if not workspace.is_dir() or workspace.stat().st_uid != os.getuid():
        raise RuntimeError('Workspace must be an existing directory owned by this user')
    identity = hashlib.sha256((str(os.getuid()) + ':' + str(user_data)).encode()).hexdigest()[:20]
    runtime = private(Path('/tmp') / ('ego-linux-' + identity))
    config = {'bootId': identity, 'userData': str(user_data),
              'workspace': str(workspace.resolve()),
              'downloads': str(private(user_data / 'Downloads')),
              'socketPath': str(runtime / 'bridge.sock'),
              'stateDir': str(private(user_data / 'sdk-state')),
              'outputDir': str(private(user_data / 'output'))}
    if os.environ.get('EGO_LINUX_CONTROL_FILE'):
        control = Path(os.environ['EGO_LINUX_CONTROL_FILE'])
        if not control.is_absolute():
            raise RuntimeError('EGO_LINUX_CONTROL_FILE must be absolute')
        config['controlFile'] = str(control)
    allowed = ('PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY',
               'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
               'XDG_STATE_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR')
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env['EGO_LINUX_RUNTIME'] = str(runtime)
    electron = Path(os.environ.get('EGO_LINUX_ELECTRON', str(ROOT / 'node_modules/electron/dist/electron')))
    if not electron.is_absolute() or not electron.is_file():
        raise RuntimeError('Install the pinned Electron dependency, or set EGO_LINUX_ELECTRON to its absolute path')
    args = [str(electron), str(ROOT)]
    args.extend(value for value in sys.argv[1:] if value.startswith(('https://', 'http://')))
    if not listening(runtime / 'bridge.sock'):
        launch(runtime, args, env, config)
    elif len(args) > 2:
        subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    if '--prepare' in sys.argv:
        print(json.dumps(config))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
