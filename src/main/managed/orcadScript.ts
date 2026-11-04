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
# R2 (agent state on the server): agents get hook settings (claude --settings / gemini system defaults) that run 'orcad.py hook <cli>';
#   the daemon broadcasts a status event to attached clients and keeps the last one (late clients get it on attach and in list).
# R3 (server accounts): accounts/<id>/ is one CLI login (CLAUDE_CONFIG_DIR / CODEX_HOME, 700). Claude history folders are links into
#   claude-shared/ so any account can --resume any conversation. The user's own ~/.claude is never touched. All of it lives in this folder.
# R4 (chat view on the server's transcript): 'read' returns whole lines of a .jsonl under claude-shared/ or accounts/ only
#   (tail first, then by byte offset, capped). Hooks also pass transcript_path and the prompt (tab title / chat name).
#   A session on the server's own login writes under ~/.claude/projects: only the one file that session's own hook named is
#   readable, and only by a read for that session (bound in the session ledger).
# Lives in ONE folder (this file's folder). Unix socket only (no TCP port). No root, no systemd, no crontab.
# Exits by itself when it has no sessions and no clients. stdlib only, python >= 3.6, Linux.
import codecs, errno, fcntl, hmac, json, os, pty, re, selectors, shutil, signal, socket, stat, struct, subprocess, sys, termios, time

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
SESSION_ENV = 'ARA_ORCAD_SESSION'
HOOK_IN_MAX = 2 << 20
HOOK_WAIT_S = 1.5
HOOK_STR_MAX = 256
TOOL_INPUT_MAX = 16384
# R3: session_id (resume under another account), error (StopFailure rate_limit -> 'switch account' band).
HOOK_KEYS = ('hook_event_name', 'tool_name', 'agent_id', 'agent_type', 'session_id', 'error')
# R4: transcript_path (chat view), prompt (tab title, chat name - cut to PROMPT_MAX).
PATH_MAX = 4096
PROMPT_MAX = 4096
READ_MAX = 2 << 20
LF = b'\n'
ACCOUNTS = os.path.join(DIR, 'accounts')
SHARED = os.path.join(DIR, 'claude-shared')
ACCOUNT_META = '.ara-account.json'
DEFAULT_F = os.path.join(ACCOUNTS, '.default')
ACCOUNT_ENV = {'claude': 'CLAUDE_CONFIG_DIR', 'codex': 'CODEX_HOME'}
LOGIN_FILE = {'claude': '.credentials.json', 'codex': 'auth.json'}
# Same list as src/main/usage/accounts.ts CLAUDE_HISTORY (a test compares them).
CLAUDE_HISTORY = ('projects', 'session-env', 'file-history', 'shell-snapshots', 'todos', 'paste-cache', 'tasks', 'plans', 'transcripts')
MERGE = '.ara-merge'
LABEL_MAX = 64
ACCOUNT_ID = re.compile(r'^[0-9a-f]{12}$')


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
        env[SESSION_ENV] = self.id
        # R3 account: {'agent': 'claude'|'codex', 'id': '<id>' | None (server's own login) | missing (the default account)}.
        self.account = None
        acc = spec.get('account')
        if isinstance(acc, dict) and acc.get('agent') in ACCOUNT_ENV:
            self.account = pick_account(acc.get('agent'), acc.get('id', '*'))
            if self.account:
                path = os.path.join(ACCOUNTS, self.account)
                if acc.get('agent') == 'claude':
                    share_history(path)
                env[ACCOUNT_ENV[acc.get('agent')]] = path
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
        self.status = None
        self.transcript = None
        self.info = {'id': self.id, 'pid': pid, 'cwd': cwd, 'cols': cols, 'rows': rows, 'meta': spec.get('meta') or {}, 'account': self.account}
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
        if s.status:
            d['status'] = {'source': s.status['source'], 'payload': s.status['payload'], 'at': s.status['at']}
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
        if t == 'hook':
            s = sessions.get(r.get('id'))
            payload = r.get('payload')
            if not s or not isinstance(payload, dict):
                raise ValueError('no such session')
            ev = {'type': 'status', 'id': s.id, 'source': str(r.get('source') or ''), 'payload': payload, 'at': int(time.time() * 1000)}
            # A subagent's tool event alone says little about the tab; late clients get the last top-level one.
            if not payload.get('agent_id'):
                s.status = ev
                own = own_transcript(payload.get('transcript_path'))
                if own:
                    s.transcript = own
            broadcast(s.id, ev, True)
            return None
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
        if t == 'read':
            s = sessions.get(r.get('id'))
            return read_transcript(r.get('path'), r.get('offset'), r.get('max'), s.transcript if s else None)
        if t == 'account':
            op = r.get('op')
            if op == 'add':
                return add_account(r.get('agent'), r.get('label'))
            if op == 'remove':
                aid = str(r.get('id') or '')
                account_path(aid)
                if any(s.account == aid for s in sessions.values()):
                    raise ValueError('account in use')
                remove_account(aid)
            elif op == 'default':
                set_default(r.get('id'))
            elif op != 'list':
                raise ValueError('unknown request')
            return list_accounts()
        raise ValueError('unknown request')

    def on_message(c, msg):
        if not c.authed:
            ok = isinstance(msg, dict) and msg.get('type') == 'hello' and hmac.compare_digest(str(msg.get('token') or '').encode(), token.encode())
            reply = {'type': 'hello', 'ok': ok, 'protocol': PROTOCOL, 'pid': os.getpid(), 'appVersion': read_version()}
            if ok:
                reply['hookDir'] = DIR
            else:
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
                if s.status:
                    put(c, s.status)
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


def slim(payload):
    """Only what the state needs (PostToolUse can carry whole files): event, tool, subagent, and a small tool_input (question/approval card)."""
    out = {}
    for k in HOOK_KEYS:
        v = payload.get(k)
        if isinstance(v, str) and len(v) <= HOOK_STR_MAX:
            out[k] = v
    ti = payload.get('tool_input')
    if ti is not None and len(json.dumps(ti, ensure_ascii=False)) <= TOOL_INPUT_MAX:
        out['tool_input'] = ti
    tp = payload.get('transcript_path')
    if isinstance(tp, str) and len(tp) <= PATH_MAX:
        out['transcript_path'] = tp
    pr = payload.get('prompt')
    if isinstance(pr, str):
        out['prompt'] = pr[:PROMPT_MAX]
    return out


def own_transcript(path):
    """A hook's transcript under the server login's ~/.claude/projects (resolved) - else None."""
    if not isinstance(path, str) or not path.endswith('.jsonl') or not os.path.isabs(path) or '\0' in path:
        return None
    real = os.path.realpath(path)
    root = os.path.realpath(os.path.join(os.path.expanduser('~'), '.claude', 'projects'))
    return real if real.startswith(root + os.sep) and real.endswith('.jsonl') else None


def read_transcript(path, offset, want, own=None):
    """R4 chat view: whole lines of a .jsonl under claude-shared/ or accounts/ (checked after resolving links - no escape),
    or own = the one file the asking session's hook named (server login). offset None (first open) or past the end
    (file rewritten -> reset) = the tail. A line longer than the cap is skipped."""
    if not isinstance(path, str) or not path.endswith('.jsonl') or not os.path.isabs(path) or '\0' in path:
        raise ValueError('path not allowed')
    real = os.path.realpath(path)
    if real != own and not any(real.startswith(os.path.realpath(root) + os.sep) for root in (SHARED, ACCOUNTS)):
        raise ValueError('path not allowed')
    if offset is not None and (not isinstance(offset, int) or isinstance(offset, bool) or offset < 0):
        raise ValueError('bad offset')
    want = want if isinstance(want, int) and not isinstance(want, bool) and 0 < want < READ_MAX else READ_MAX
    fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('path not allowed')
        size = st.st_size
        reset = offset is not None and offset > size
        tail = offset is None or reset
        start = max(0, size - want) if tail else offset
        os.lseek(fd, start, os.SEEK_SET)
        buf = b''
        while len(buf) < min(want, size - start):
            d = os.read(fd, min(want, size - start) - len(buf))
            if not d:
                break
            buf += d
    finally:
        os.close(fd)
    if tail and start > 0:
        # Cut into the middle of a line - drop it.
        i = buf.find(LF)
        cut = i + 1 if i >= 0 else len(buf)
        buf, start = buf[cut:], start + cut
    end = buf.rfind(LF)
    if end < 0:
        # ponytail: a line longer than the cap is skipped whole (its rest parses as junk and is dropped); raise READ_MAX if that bites.
        nxt = start + len(buf) if len(buf) >= want else start
        return {'size': size, 'next': nxt, 'text': '', 'reset': reset}
    return {'size': size, 'next': start + end + 1, 'text': buf[:end + 1].decode('utf-8', 'replace'), 'reset': reset}


def hook(source):
    """Agent hook: print {} first (a permission hook with empty output fails closed), tell the daemon, never fail the agent."""
    sys.stdout.write('{}\n')
    sys.stdout.flush()
    sid = os.environ.get(SESSION_ENV)
    if not sid or source not in ('claude', 'gemini'):
        return
    raw = sys.stdin.buffer.read(HOOK_IN_MAX + 1)
    if len(raw) > HOOK_IN_MAX:
        return
    payload = json.loads(raw.decode('utf-8', 'replace') or '{}')
    if not isinstance(payload, dict):
        return
    with open(TOKEN) as f:
        token = f.read().strip()
    s = try_connect()
    if s is None:
        return
    try:
        s.settimeout(HOOK_WAIT_S)
        s.sendall(frame({'type': 'hello', 'protocol': PROTOCOL, 'token': token}) +
                  frame({'type': 'hook', 'rid': 1, 'id': sid, 'source': source, 'payload': slim(payload)}))
        # Wait for the reply: closing early can drop the request unread.
        buf = b''
        while True:
            d = s.recv(65536)
            if not d:
                return
            buf += d
            lines = buf.split(b'\n')
            buf = lines.pop()
            for line in lines:
                try:
                    if json.loads(line.decode('utf-8')).get('type') == 'reply':
                        return
                except ValueError:
                    pass
    finally:
        s.close()


def account_path(aid):
    aid = str(aid or '')
    p = os.path.join(ACCOUNTS, aid)
    if not ACCOUNT_ID.match(aid) or os.path.islink(p) or not os.path.isfile(os.path.join(p, ACCOUNT_META)):
        raise ValueError('no such account')
    return p


def account_info(aid):
    p = os.path.join(ACCOUNTS, aid)
    with open(os.path.join(p, ACCOUNT_META)) as f:
        m = json.load(f)
    agent = m.get('agent')
    email = None
    if agent == 'claude':
        try:
            with open(os.path.join(p, '.claude.json')) as f:
                email = (json.load(f).get('oauthAccount') or {}).get('emailAddress')
        except (OSError, ValueError, AttributeError):
            pass
    return {'id': aid, 'agent': agent, 'label': m.get('label') or aid, 'createdAt': m.get('createdAt'),
            'loggedIn': os.path.exists(os.path.join(p, LOGIN_FILE.get(agent, ACCOUNT_META + '-'))),
            'email': email if isinstance(email, str) else None}


def read_default():
    try:
        with open(DEFAULT_F) as f:
            aid = f.read().strip()
        account_path(aid)
        return aid
    except (OSError, ValueError):
        return None


def list_accounts():
    out = []
    if os.path.isdir(ACCOUNTS):
        for aid in os.listdir(ACCOUNTS):
            try:
                account_path(aid)
                out.append(account_info(aid))
            except (OSError, ValueError):
                pass
    out.sort(key=lambda a: a.get('createdAt') or 0)
    return {'accounts': out, 'default': read_default()}


def pick_account(agent, aid):
    """'*' = the default account if it is this agent's, None = the server's own login, else that account (must be this agent's)."""
    if aid == '*':
        d = read_default()
        return d if d and account_info(d).get('agent') == agent else None
    if aid is None:
        return None
    account_path(aid)
    if account_info(aid).get('agent') != agent:
        raise ValueError('no such account')
    return str(aid)


def private_dir(p):
    os.makedirs(p, 0o700, exist_ok=True)
    os.chmod(p, 0o700)


def add_account(agent, label):
    if agent not in ACCOUNT_ENV:
        raise ValueError('unknown agent')
    private_dir(ACCOUNTS)
    aid = codecs.encode(os.urandom(6), 'hex').decode()
    p = os.path.join(ACCOUNTS, aid)
    os.mkdir(p, 0o700)
    os.chmod(p, 0o700)
    name = ' '.join(str(label or '').split())[:LABEL_MAX]
    with open(os.path.join(p, ACCOUNT_META), 'w') as f:
        json.dump({'agent': agent, 'label': name, 'createdAt': int(time.time() * 1000)}, f)
    if agent == 'claude':
        share_history(p)
    return account_info(aid)


def remove_account(aid):
    """Only this account's folder. Links into claude-shared/ are unlinked first, never followed - the shared history stays."""
    p = account_path(aid)
    for name in os.listdir(p):
        q = os.path.join(p, name)
        if os.path.islink(q):
            os.unlink(q)
    shutil.rmtree(p)
    if read_default() is None:
        set_default(None)


def set_default(aid):
    if aid is None:
        try:
            os.unlink(DEFAULT_F)
        except OSError:
            pass
        return
    account_path(aid)
    with open(DEFAULT_F, 'w') as f:
        f.write(str(aid))


def move_tree(src, dst):
    """Move src's entries into dst; an entry already in dst stays in src (kept). Removes src when emptied. -> kept count."""
    kept = 0
    for name in os.listdir(src):
        a = os.path.join(src, name)
        b = os.path.join(dst, name)
        try:
            if not os.path.lexists(b):
                os.rename(a, b)
            elif os.path.isdir(a) and not os.path.islink(a) and os.path.isdir(b) and not os.path.islink(b):
                kept += move_tree(a, b)
            else:
                kept += 1
        except OSError:
            kept += 1
    if not os.listdir(src):
        os.rmdir(src)
    return kept


def share_dir(acc, name):
    """Same order as the app's local accounts (shareHistoryDir): set aside -> link -> move into shared (clashes stay in <name>.ara-merge)."""
    src = os.path.join(acc, name)
    dest = os.path.join(SHARED, name)
    pending = src + MERGE
    private_dir(SHARED)
    os.makedirs(dest, exist_ok=True)
    if os.path.isdir(pending) and not os.path.islink(pending) and os.path.islink(src):
        move_tree(pending, dest)
    if os.path.islink(src):
        return True
    had = os.path.lexists(src)
    if had and not os.path.isdir(src):
        return False
    if had:
        if os.path.lexists(pending):
            return False
        os.rename(src, pending)
    try:
        os.symlink(dest, src)
    except OSError:
        if had and not os.path.lexists(src):
            os.rename(pending, src)
        return False
    if had:
        move_tree(pending, dest)
    return True


def share_history(acc):
    for name in CLAUDE_HISTORY:
        try:
            share_dir(acc, name)
        except OSError:
            pass


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
    elif cmd == 'hook':
        try:
            hook(sys.argv[2] if len(sys.argv) > 2 else '')
        except Exception:  # noqa - a hook must never break the agent
            pass
        sys.exit(0)
    elif cmd == 'version':
        print('protocol=%d' % PROTOCOL)
    else:
        sys.stderr.write('usage: orcad.py serve|connect|stop|version|hook <cli>\n')
        sys.exit(64)
`
