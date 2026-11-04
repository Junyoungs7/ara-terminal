// M8 DM-02 orcad — 원격 서버에 올라가는 데몬 스크립트(python3 표준 라이브러리만). 동의한 호스트의 ~/.ara-server/orcad.py 로 올라간다(host.ts installHost).
// 로컬 데몬(main/daemon/daemonEntry.ts)과 같은 말(NDJSON·hello 토큰·create/list/attach/write/resize/kill/killAll/shutdown, data/exit 사건)을 한다 —
// 아라 쪽은 daemon/client.ts 를 그대로 쓴다(connectDaemonStream). 차이: 유닉스 소켓을 원격 설치 폴더에, 아라와는 SSH exec 다리(connect)로 잇는다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/orcad·managed-server/lifecycle/orcad-stdio-bridge-script.ts 의 구조(원격 데몬 + stdio 다리) — 코드는 새로 씀(Orca 는 Node).
// 생애: 세션도 붙은 연결도 없으면 스스로 끝난다(띄우고 30초 안에 아무도 안 오면, 또는 마지막 연결이 떠나고 세션이 없으면). SSH 가 끊겨도 세션은 산다(setsid).
// ⚠️ String.raw 안이다 — 파이썬에 백틱·달러+여는중괄호를 쓰지 말 것(시험 managedServers.test.ts 가 원격 python 으로 문법을 본다).
export const ORCAD_PY = String.raw`#!/usr/bin/env python3
# A.R.A orcad - remote agent terminal daemon (M8 DM-02). Installed only with the user's per-host consent.
# Same wire protocol as the local daemon (src/main/daemon/protocol.ts): NDJSON, hello+token, create/list/attach/write/resize/kill/killAll/shutdown.
# R1 (several PCs): attach carries the PC name, detach (close on this PC only), meta (patch title etc.), viewers event (who is attached).
# Lives in ONE folder (this file's folder). Unix socket only (no TCP port). No root, no systemd, no crontab.
# Exits by itself when it has no sessions and no clients. stdlib only, python >= 3.6, Linux.
import codecs, errno, fcntl, hmac, json, os, pty, selectors, signal, socket, stat, struct, subprocess, sys, termios, time

PROTOCOL = 1
DIR = os.path.dirname(os.path.abspath(__file__))
SOCK = os.path.join(DIR, 'orcad.sock')
TOKEN = os.path.join(DIR, 'token')
PIDF = os.path.join(DIR, 'orcad.pid')
LOGF = os.path.join(DIR, 'orcad.log')
VERF = os.path.join(DIR, 'version')
# Stable SSH agent path (herdr ssh_agent idea): sessions get SSH_AUTH_SOCK=AGENT, each connect repoints it to its own forwarded socket.
AGENT = os.path.join(DIR, 'agent.sock')
MARK = 'ARA_ORCAD_HOME'
LOG_MAX = 1 << 20
REPLAY_CAP = 2 * 1024 * 1024
OUT_MAX = 16 << 20
FRAME_MAX = 8 << 20
GRACE_S = 30
HELLO_S = 5
KILL_WAIT_S = 3
PC_MAX = 64
META_MAX = 4096


def log(msg):
    try:
        with open(LOGF, 'a') as f:
            f.write('%s [orcad %d] %s\n' % (time.strftime('%Y-%m-%dT%H:%M:%S'), os.getpid(), msg))
    except OSError:
        pass


def frame(obj):
    return (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')


class Stop(Exception):
    pass


class Session(object):
    def __init__(self, spec):
        self.id = str(spec['id'])
        cwd = spec.get('cwd') or os.path.expanduser('~')
        if not os.path.isdir(cwd):
            raise ValueError('no such folder: %s' % cwd)
        cols = int(spec.get('cols') or 80)
        rows = int(spec.get('rows') or 24)
        env = dict(os.environ)
        for k, v in (spec.get('env') or {}).items():
            env[str(k)] = str(v)
        env['TERM'] = 'xterm-256color'
        env[MARK] = DIR
        if os.path.islink(AGENT):
            env['SSH_AUTH_SOCK'] = AGENT
        shell = env.get('SHELL') or '/bin/sh'
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                os.execve(shell, [shell, '-l'], env)
            finally:
                os._exit(127)
        self.pid = pid
        self.fd = fd
        self.dec = codecs.getincrementaldecoder('utf-8')('replace')
        self.replay = []
        self.size = 0
        self.info = {'id': self.id, 'pid': pid, 'cwd': cwd, 'cols': cols, 'rows': rows, 'meta': spec.get('meta') or {}}
        self.resize(cols, rows)

    def resize(self, cols, rows):
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            self.info['cols'] = cols
            self.info['rows'] = rows
        except OSError:
            pass

    def push(self, s):
        self.replay.append(s)
        self.size += len(s)
        while self.size > REPLAY_CAP and len(self.replay) > 1:
            self.size -= len(self.replay.pop(0))
        if self.size > REPLAY_CAP:
            self.replay[0] = self.replay[0][self.size - REPLAY_CAP:]
            self.size = REPLAY_CAP

    def signal(self, sig):
        try:
            os.killpg(self.pid, sig)
        except OSError:
            pass

    def reap(self):
        """exit code (128+signal for signals), waits a little, then kills."""
        deadline = time.time() + KILL_WAIT_S
        while True:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                return 0, None
            if pid:
                if os.WIFSIGNALED(status):
                    return 128 + os.WTERMSIG(status), os.WTERMSIG(status)
                return os.WEXITSTATUS(status), None
            if time.time() > deadline:
                self.signal(signal.SIGKILL)
                deadline = time.time() + KILL_WAIT_S
            time.sleep(0.05)


class Client(object):
    def __init__(self, sock):
        self.sock = sock
        self.authed = False
        self.attached = set()
        self.inbuf = b''
        self.out = bytearray()
        self.born = time.time()
        self.pc = ''


def serve():
    try:
        if os.path.getsize(LOGF) > LOG_MAX:
            open(LOGF, 'w').close()
    except OSError:
        pass
    if os.path.exists(SOCK):
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(SOCK)
            probe.close()
            log('another orcad is serving - leaving')
            sys.exit(3)
        except OSError:
            probe.close()
            os.unlink(SOCK)
    with open(TOKEN) as f:
        token = f.read().strip()
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        srv.bind(SOCK)
    finally:
        os.umask(old)
    srv.listen(16)
    srv.setblocking(False)
    with open(PIDF, 'w') as f:
        f.write(str(os.getpid()))
    log('listening %s protocol=%d' % (SOCK, PROTOCOL))

    sel = selectors.DefaultSelector()
    sel.register(srv, selectors.EVENT_READ, ('srv', None))
    sessions = {}
    by_fd = {}
    clients = {}
    state = {'down': False, 'last_empty': time.time()}

    def on_term(signum, _frame):
        raise Stop()
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    def want(c):
        ev = selectors.EVENT_READ | (selectors.EVENT_WRITE if c.out else 0)
        sel.modify(c.sock, ev, ('cli', c))

    def put(c, obj):
        if c.sock.fileno() < 0:
            return
        c.out += frame(obj)
        if len(c.out) > OUT_MAX:
            log('client too slow - dropping')
            drop(c)
            return
        flush(c)

    def flush(c):
        try:
            while c.out:
                n = os.write(c.sock.fileno(), c.out)
                del c.out[:n]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            drop(c)
            return
        if c.sock.fileno() >= 0:
            want(c)

    def drop(c):
        if c.sock not in clients:
            return
        del clients[c.sock]
        try:
            sel.unregister(c.sock)
        except (KeyError, ValueError):
            pass
        c.sock.close()
        for sid in list(c.attached):
            tell_viewers(sid)

    def viewers_of(sid):
        return sorted((c.pc or '?') for c in clients.values() if c.authed and sid in c.attached)

    def tell_viewers(sid):
        if sid in sessions:
            broadcast(sid, {'type': 'viewers', 'id': sid, 'viewers': viewers_of(sid)}, True)

    def info_of(s):
        d = dict(s.info)
        d['viewers'] = viewers_of(s.id)
        return d

    def broadcast(sid, ev, only_attached):
        for c in list(clients.values()):
            if c.authed and (not only_attached or sid in c.attached):
                put(c, ev)

    def end_session(s):
        try:
            sel.unregister(s.fd)
        except (KeyError, ValueError):
            pass
        try:
            os.close(s.fd)
        except OSError:
            pass
        by_fd.pop(s.fd, None)
        sessions.pop(s.id, None)
        code, sig = s.reap()
        log('session exit %s pid=%d code=%d' % (s.id, s.pid, code))
        ev = {'type': 'exit', 'id': s.id, 'code': code}
        if sig:
            ev['signal'] = sig
        broadcast(s.id, ev, False)

    def create(spec):
        if str(spec.get('id')) in sessions:
            raise ValueError('duplicate session id')
        s = Session(spec)
        sessions[s.id] = s
        by_fd[s.fd] = s
        os.set_blocking(s.fd, False)
        sel.register(s.fd, selectors.EVENT_READ, ('pty', s))
        log('session create %s pid=%d cwd=%s' % (s.id, s.pid, s.info['cwd']))
        return s.info

    def handle(c, r):
        t = r.get('type')
        if t == 'create':
            return create(r.get('spec') or {})
        if t == 'list':
            return [info_of(s) for s in sessions.values()]
        if t == 'attach':
            s = sessions.get(r.get('id'))
            if not s:
                raise ValueError('no such session')
            if r.get('pc'):
                c.pc = str(r.get('pc'))[:PC_MAX]
            return info_of(s)
        if t == 'detach':
            sid = r.get('id')
            if sid in c.attached:
                c.attached.discard(sid)
                tell_viewers(sid)
            return None
        if t == 'meta':
            s = sessions.get(r.get('id'))
            patch = r.get('meta')
            if not s or not isinstance(patch, dict):
                raise ValueError('no such session')
            m = dict(s.info['meta'])
            for k, v in patch.items():
                if v is None:
                    m.pop(str(k), None)
                else:
                    m[str(k)] = v
            if len(json.dumps(m)) > META_MAX:
                raise ValueError('meta too big')
            s.info['meta'] = m
            broadcast(s.id, {'type': 'meta', 'id': s.id, 'meta': m}, True)
            return m
        if t == 'write':
            s = sessions.get(r.get('id'))
            if s:
                data = str(r.get('data') or '').encode('utf-8')
                try:
                    os.write(s.fd, data)
                except OSError:
                    pass
            return None
        if t == 'resize':
            s = sessions.get(r.get('id'))
            cols, rows = int(r.get('cols') or 0), int(r.get('rows') or 0)
            if s and cols > 0 and rows > 0:
                s.resize(cols, rows)
            return None
        if t == 'kill':
            s = sessions.get(r.get('id'))
            if s:
                s.signal(signal.SIGHUP)
            return None
        if t == 'killAll':
            for s in sessions.values():
                s.signal(signal.SIGHUP)
            return len(sessions)
        if t == 'shutdown':
            raise Stop()
        if t == 'limits':
            return None
        raise ValueError('unknown request')

    def on_message(c, msg):
        if not c.authed:
            ok = isinstance(msg, dict) and msg.get('type') == 'hello' and hmac.compare_digest(str(msg.get('token') or '').encode(), token.encode())
            reply = {'type': 'hello', 'ok': ok, 'protocol': PROTOCOL, 'pid': os.getpid(), 'appVersion': read_version()}
            if not ok:
                reply['error'] = 'token'
            put(c, reply)
            if not ok:
                log('hello rejected')
                drop(c)
            else:
                c.authed = True
            return
        if not isinstance(msg, dict):
            return
        rid = msg.get('rid') or 0
        try:
            result = handle(c, msg)
            if rid:
                put(c, {'type': 'reply', 'rid': rid, 'ok': True, 'result': result})
            if msg.get('type') == 'attach':
                s = sessions[msg.get('id')]
                for chunk in s.replay:
                    put(c, {'type': 'data', 'id': s.id, 'data': chunk})
                c.attached.add(s.id)
                tell_viewers(s.id)
        except Stop:
            if rid:
                put(c, {'type': 'reply', 'rid': rid, 'ok': True, 'result': None})
            raise
        except Exception as e:  # noqa
            if rid:
                put(c, {'type': 'reply', 'rid': rid, 'ok': False, 'error': str(e)})

    def read_client(c):
        try:
            data = c.sock.recv(65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b''
        if not data:
            drop(c)
            return
        c.inbuf += data
        while b'\n' in c.inbuf:
            line, c.inbuf = c.inbuf.split(b'\n', 1)
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode('utf-8'))
            except ValueError:
                continue
            on_message(c, msg)
            if c.sock not in clients:
                return
        if len(c.inbuf) > FRAME_MAX:
            drop(c)

    def read_pty(s):
        try:
            data = os.read(s.fd, 65536)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            data = b''
        if not data:
            end_session(s)
            return
        text = s.dec.decode(data)
        if text:
            s.push(text)
            broadcast(s.id, {'type': 'data', 'id': s.id, 'data': text}, True)

    def shutdown_all(why):
        log('exit: %s' % why)
        for s in list(sessions.values()):
            s.signal(signal.SIGHUP)
        for s in list(sessions.values()):
            end_session(s)
        for c in list(clients.values()):
            flush(c)
            drop(c)

    try:
        while True:
            if not sessions and not clients:
                left = GRACE_S - (time.time() - state['last_empty'])
                if left <= 0:
                    shutdown_all('idle (no sessions, no clients)')
                    break
                timeout = left
            else:
                state['last_empty'] = time.time()
                timeout = HELLO_S
            for key, mask in sel.select(timeout):
                kind, obj = key.data
                if kind == 'srv':
                    try:
                        sock, _ = srv.accept()
                    except OSError:
                        continue
                    sock.setblocking(False)
                    c = Client(sock)
                    clients[sock] = c
                    sel.register(sock, selectors.EVENT_READ, ('cli', c))
                elif kind == 'cli':
                    if obj.sock not in clients:
                        continue
                    if mask & selectors.EVENT_WRITE:
                        flush(obj)
                    if mask & selectors.EVENT_READ and obj.sock in clients:
                        read_client(obj)
                elif kind == 'pty':
                    if obj.id in sessions:
                        read_pty(obj)
            now = time.time()
            for c in list(clients.values()):
                if not c.authed and now - c.born > HELLO_S:
                    drop(c)
            # A client that was there and left with no sessions alive: nothing to keep -> go now (same as local daemon).
            if not sessions and not clients and state.get('had_client'):
                shutdown_all('idle (no sessions, no clients)')
                break
            if clients:
                state['had_client'] = True
    except Stop:
        shutdown_all('shutdown')
    finally:
        cleanup()


def read_version():
    try:
        with open(VERF) as f:
            return f.read().strip()
    except OSError:
        return None


def cleanup():
    try:
        with open(PIDF) as f:
            mine = f.read().strip() == str(os.getpid())
    except OSError:
        mine = False
    if mine:
        for p in (SOCK, PIDF):
            try:
                os.unlink(p)
            except OSError:
                pass


def try_connect():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(SOCK)
        return s
    except OSError:
        s.close()
        return None


def publish_agent():
    """Point AGENT at this connection's forwarded agent (only a user-owned socket). Atomic: new link, then rename over."""
    src = os.environ.get('SSH_AUTH_SOCK') or ''
    if not src or not os.path.isabs(src) or src == AGENT:
        return
    try:
        st = os.stat(src)
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.geteuid():
            return
        tmp = AGENT + '.%d' % os.getpid()
        if os.path.lexists(tmp):
            os.unlink(tmp)
        os.symlink(src, tmp)
        os.rename(tmp, AGENT)
    except OSError as e:
        log('agent link failed: %s' % e)


def bridge():
    """stdin/stdout <-> daemon socket. Starts the daemon if it is not running. Ends when either side closes."""
    publish_agent()
    s = try_connect()
    if s is None:
        env = dict(os.environ)
        env[MARK] = DIR
        subprocess.Popen([sys.executable, os.path.abspath(__file__), 'serve'], cwd=DIR, env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, start_new_session=True)
        deadline = time.time() + 10
        while s is None and time.time() < deadline:
            time.sleep(0.05)
            s = try_connect()
    if s is None:
        sys.stderr.write('orcad: daemon did not start\n')
        sys.exit(2)
    sel = selectors.DefaultSelector()
    sel.register(0, selectors.EVENT_READ, 'in')
    sel.register(s, selectors.EVENT_READ, 'sock')
    while True:
        for key, _ in sel.select():
            if key.data == 'in':
                data = os.read(0, 65536)
                if not data:
                    s.close()
                    return
                s.sendall(data)
            else:
                try:
                    data = s.recv(65536)
                except OSError:
                    data = b''
                if not data:
                    return
                view = memoryview(data)
                while view:
                    n = os.write(1, view)
                    view = view[n:]


def stop():
    """SIGTERM the daemon (it ends its sessions), wait for it."""
    try:
        with open(PIDF) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.time() + KILL_WAIT_S * 3
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.05)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'serve':
        serve()
    elif cmd == 'connect':
        try:
            bridge()
        except (BrokenPipeError, KeyboardInterrupt):
            pass
    elif cmd == 'stop':
        stop()
    elif cmd == 'version':
        print('protocol=%d' % PROTOCOL)
    else:
        sys.stderr.write('usage: orcad.py serve|connect|stop|version\n')
        sys.exit(64)
`
