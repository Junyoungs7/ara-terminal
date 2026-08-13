// F18 명령어 북 — 리눅스 명령어 참조 데이터. 정적 콘텐츠 하나, 네트워크 호출 없음.
// UI(interactions/CommandBook.tsx)는 이 배열을 검색·펼침만 한다 — 데이터와 화면을 분리해
// 콘텐츠를 늘릴 때 컴포넌트를 건드리지 않게 한다.

export type CommandCategory =
  | 'file'
  | 'process'
  | 'network'
  | 'disk'
  | 'perm'
  | 'package'
  | 'systemd'
  | 'archive'
  | 'search'
  | 'text'
  | 'tmux'

export const CATEGORY_LABEL: Record<CommandCategory, string> = {
  file: '파일',
  process: '프로세스',
  network: '네트워크',
  disk: '디스크',
  perm: '권한',
  package: '패키지',
  systemd: 'systemd',
  archive: '압축',
  search: '검색',
  text: '텍스트처리',
  tmux: 'tmux'
}

export type CommandExample = { cmd: string; note?: string }

export type CommandEntry = {
  id: string
  category: CommandCategory
  cmd: string
  desc: string
  examples: readonly CommandExample[]
  caution?: string
}

// 50~80개 규모. 실제로 자주 쓰는 것만 — 기초부터 조합형까지.
export const COMMAND_BOOK: readonly CommandEntry[] = [
  // ── 파일 ──
  { id: 'ls', category: 'file', cmd: 'ls -la', desc: '숨김 파일까지 자세히 목록을 봅니다.', examples: [{ cmd: 'ls -la /var/log' }] },
  { id: 'cp', category: 'file', cmd: 'cp -r', desc: '디렉터리를 재귀적으로 복사합니다.', examples: [{ cmd: 'cp -r ./src ./backup' }] },
  { id: 'mv', category: 'file', cmd: 'mv', desc: '파일·디렉터리를 이동하거나 이름을 바꿉니다.', examples: [{ cmd: 'mv app.log app.log.bak' }] },
  { id: 'rm', category: 'file', cmd: 'rm -rf', desc: '디렉터리를 강제로 재귀 삭제합니다.', examples: [{ cmd: 'rm -rf ./tmp/build' }], caution: '되돌릴 수 없습니다 — 경로를 두 번 확인하세요.' },
  { id: 'mkdir', category: 'file', cmd: 'mkdir -p', desc: '중간 경로까지 한 번에 만듭니다.', examples: [{ cmd: 'mkdir -p ./a/b/c' }] },
  { id: 'touch', category: 'file', cmd: 'touch', desc: '빈 파일을 만들거나 수정 시각을 갱신합니다.', examples: [{ cmd: 'touch notes.txt' }] },
  { id: 'ln', category: 'file', cmd: 'ln -s', desc: '심볼릭 링크를 만듭니다.', examples: [{ cmd: 'ln -s /opt/app/current /opt/app/latest' }] },
  { id: 'stat', category: 'file', cmd: 'stat', desc: '파일의 크기·권한·수정 시각 등 상세 정보를 봅니다.', examples: [{ cmd: 'stat app.log' }] },
  { id: 'readlink', category: 'file', cmd: 'readlink -f', desc: '심볼릭 링크의 실제 절대경로를 확인합니다.', examples: [{ cmd: 'readlink -f ./latest' }] },
  { id: 'rsync', category: 'file', cmd: 'rsync -avz', desc: '변경분만 압축 전송하는 원격 복사입니다.', examples: [{ cmd: 'rsync -avz ./dist/ user@host:/srv/app/' }] },
  { id: 'scp', category: 'file', cmd: 'scp -r', desc: 'SSH 로 원격 파일·디렉터리를 복사합니다.', examples: [{ cmd: 'scp -r ./dist user@host:/srv/app' }] },
  { id: 'df', category: 'disk', cmd: 'df -h', desc: '디스크 파티션별 사용량을 사람이 읽기 쉬운 단위로 봅니다.', examples: [{ cmd: 'df -h' }] },

  // ── 프로세스 ──
  { id: 'ps', category: 'process', cmd: 'ps aux', desc: '실행 중인 모든 프로세스를 상세히 봅니다.', examples: [{ cmd: 'ps aux | grep node' }] },
  { id: 'top', category: 'process', cmd: 'top', desc: 'CPU·메모리 사용량을 실시간으로 봅니다.', examples: [{ cmd: 'top' }] },
  { id: 'htop', category: 'process', cmd: 'htop', desc: 'top 보다 보기 좋은 대화형 프로세스 뷰어입니다.', examples: [{ cmd: 'htop' }] },
  { id: 'kill', category: 'process', cmd: 'kill -9', desc: '프로세스를 PID 로 강제 종료합니다.', examples: [{ cmd: 'kill -9 41231' }], caution: '저장하지 않은 작업이 즉시 사라집니다.' },
  { id: 'pkill', category: 'process', cmd: 'pkill -f', desc: '명령줄 문자열로 프로세스를 찾아 종료합니다.', examples: [{ cmd: 'pkill -f "node server.js"' }], caution: '이름이 겹치는 다른 프로세스도 함께 죽을 수 있습니다.' },
  { id: 'nohup', category: 'process', cmd: 'nohup … &', desc: '터미널을 닫아도 계속 도는 백그라운드 실행입니다.', examples: [{ cmd: 'nohup ./run.sh > run.log 2>&1 &' }] },
  { id: 'jobs', category: 'process', cmd: 'jobs', desc: '현재 셸의 백그라운드 작업 목록을 봅니다.', examples: [{ cmd: 'jobs -l' }] },
  { id: 'fg', category: 'process', cmd: 'fg', desc: '백그라운드 작업을 다시 앞으로 가져옵니다.', examples: [{ cmd: 'fg %1' }] },
  { id: 'nice', category: 'process', cmd: 'nice -n', desc: '프로세스 우선순위를 낮춰 시작합니다.', examples: [{ cmd: 'nice -n 10 ./batch.sh' }] },
  { id: 'renice', category: 'process', cmd: 'renice', desc: '이미 실행 중인 프로세스의 우선순위를 바꿉니다.', examples: [{ cmd: 'renice -n 10 -p 41231' }] },
  { id: 'lsof', category: 'process', cmd: 'lsof -p', desc: '프로세스가 열고 있는 파일·소켓 목록을 봅니다.', examples: [{ cmd: 'lsof -p 41231' }] },

  // ── 네트워크 ──
  { id: 'ss', category: 'network', cmd: 'ss -tlnp', desc: '리슨 중인 TCP 포트와 소유 프로세스를 봅니다.', examples: [{ cmd: 'ss -tlnp' }] },
  { id: 'curl', category: 'network', cmd: 'curl -sS', desc: 'HTTP 요청을 보내고 조용히 결과만 봅니다.', examples: [{ cmd: 'curl -sS -o /dev/null -w "%{http_code}" https://example.com' }] },
  { id: 'ping', category: 'network', cmd: 'ping -c', desc: '지정한 횟수만큼 핑을 보내고 멈춥니다.', examples: [{ cmd: 'ping -c 4 8.8.8.8' }] },
  { id: 'dig', category: 'network', cmd: 'dig', desc: 'DNS 레코드를 조회합니다.', examples: [{ cmd: 'dig example.com +short' }] },
  { id: 'traceroute', category: 'network', cmd: 'traceroute', desc: '목적지까지 경로의 각 홉을 봅니다.', examples: [{ cmd: 'traceroute example.com' }] },
  { id: 'nc', category: 'network', cmd: 'nc -zv', desc: '지정 포트가 열려 있는지 빠르게 확인합니다.', examples: [{ cmd: 'nc -zv example.com 443' }] },
  { id: 'wget', category: 'network', cmd: 'wget', desc: 'URL 에서 파일을 내려받습니다.', examples: [{ cmd: 'wget https://example.com/file.tar.gz' }] },
  { id: 'ip-addr', category: 'network', cmd: 'ip addr', desc: '네트워크 인터페이스와 할당된 IP 를 봅니다.', examples: [{ cmd: 'ip addr show' }] },
  { id: 'iptables-list', category: 'network', cmd: 'iptables -L -n', desc: '현재 방화벽 규칙을 봅니다.', examples: [{ cmd: 'iptables -L -n -v' }] },

  // ── 디스크 ──
  { id: 'du', category: 'disk', cmd: 'du -sh', desc: '디렉터리 용량을 사람이 읽기 쉬운 단위로 합산합니다.', examples: [{ cmd: 'du -sh /var/log/*' }, { cmd: 'du -sh /var/log/* | sort -rh | head -10', note: '용량 상위 10개' }] },
  { id: 'mount', category: 'disk', cmd: 'mount', desc: '현재 마운트된 파일시스템 목록을 봅니다.', examples: [{ cmd: 'mount | grep /data' }] },
  { id: 'lsblk', category: 'disk', cmd: 'lsblk', desc: '블록 디바이스(디스크·파티션) 트리를 봅니다.', examples: [{ cmd: 'lsblk' }] },
  { id: 'fdisk', category: 'disk', cmd: 'fdisk -l', desc: '디스크 파티션 테이블을 상세히 봅니다.', examples: [{ cmd: 'fdisk -l' }] },
  { id: 'ncdu', category: 'disk', cmd: 'ncdu', desc: '디렉터리 용량을 대화형으로 파고들며 확인합니다.', examples: [{ cmd: 'ncdu /var/log' }] },

  // ── 권한 ──
  { id: 'chmod', category: 'perm', cmd: 'chmod', desc: '파일 접근 권한을 바꿉니다.', examples: [{ cmd: 'chmod 644 config.yml' }, { cmd: 'chmod +x deploy.sh' }] },
  { id: 'chown', category: 'perm', cmd: 'chown', desc: '파일 소유자·그룹을 바꿉니다.', examples: [{ cmd: 'chown -R deploy:deploy /srv/app' }], caution: '루트 권한이 필요하고, 대상이 잘못되면 서비스 계정이 접근을 잃을 수 있습니다.' },
  { id: 'sudo', category: 'perm', cmd: 'sudo -i', desc: '루트 셸로 전환합니다.', examples: [{ cmd: 'sudo -i' }], caution: '이후 실행하는 모든 명령이 관리자 권한으로 돕니다.' },
  { id: 'su', category: 'perm', cmd: 'su -', desc: '다른 사용자로 전환하며 환경도 함께 바꿉니다.', examples: [{ cmd: 'su - deploy' }] },
  { id: 'id', category: 'perm', cmd: 'id', desc: '현재 사용자의 UID·GID·소속 그룹을 봅니다.', examples: [{ cmd: 'id' }] },
  { id: 'chgrp', category: 'perm', cmd: 'chgrp', desc: '파일의 소속 그룹만 바꿉니다.', examples: [{ cmd: 'chgrp deploy config.yml' }] },
  { id: 'umask', category: 'perm', cmd: 'umask', desc: '새로 만들 파일의 기본 권한 마스크를 봅니다.', examples: [{ cmd: 'umask' }] },

  // ── 패키지 ──
  { id: 'apt-update', category: 'package', cmd: 'apt update && apt upgrade', desc: '패키지 목록을 갱신하고 설치된 패키지를 올립니다.', examples: [{ cmd: 'sudo apt update && sudo apt upgrade -y' }] },
  { id: 'apt-install', category: 'package', cmd: 'apt install', desc: 'Debian/Ubuntu 계열 패키지를 설치합니다.', examples: [{ cmd: 'sudo apt install -y nginx' }] },
  { id: 'yum-install', category: 'package', cmd: 'yum install', desc: 'RHEL/CentOS 계열 패키지를 설치합니다.', examples: [{ cmd: 'sudo yum install -y nginx' }] },
  { id: 'dpkg-query', category: 'package', cmd: 'dpkg -l', desc: '설치된 .deb 패키지 목록을 봅니다.', examples: [{ cmd: 'dpkg -l | grep nginx' }] },
  { id: 'npm-ci', category: 'package', cmd: 'npm ci', desc: 'package-lock.json 대로 정확히 재설치합니다.', examples: [{ cmd: 'npm ci' }] },
  { id: 'pip-install', category: 'package', cmd: 'pip install -r', desc: 'requirements.txt 의 파이썬 패키지를 설치합니다.', examples: [{ cmd: 'pip install -r requirements.txt' }] },

  // ── systemd ──
  { id: 'systemctl-status', category: 'systemd', cmd: 'systemctl status', desc: '서비스의 현재 상태를 봅니다.', examples: [{ cmd: 'systemctl status nginx' }] },
  { id: 'systemctl-restart', category: 'systemd', cmd: 'systemctl restart', desc: '서비스를 재시작합니다.', examples: [{ cmd: 'systemctl restart nginx' }], caution: '재시작 중 짧게 서비스가 끊깁니다.' },
  { id: 'systemctl-enable', category: 'systemd', cmd: 'systemctl enable', desc: '부팅 시 서비스가 자동 시작되게 등록합니다.', examples: [{ cmd: 'systemctl enable nginx' }] },
  { id: 'journalctl-u', category: 'systemd', cmd: 'journalctl -u', desc: '특정 서비스의 로그만 봅니다.', examples: [{ cmd: 'journalctl -u nginx -n 100' }, { cmd: 'journalctl -u nginx -f', note: '실시간 팔로우' }] },
  { id: 'systemctl-list', category: 'systemd', cmd: 'systemctl list-units', desc: '현재 로드된 유닛(서비스) 목록을 봅니다.', examples: [{ cmd: 'systemctl list-units --type=service --state=running' }] },

  // ── 압축 ──
  { id: 'tar-c', category: 'archive', cmd: 'tar -czf', desc: '디렉터리를 gzip 압축 tar 로 묶습니다.', examples: [{ cmd: 'tar -czf backup.tar.gz ./data' }] },
  { id: 'tar-x', category: 'archive', cmd: 'tar -xzf', desc: 'gzip tar 압축을 풉니다.', examples: [{ cmd: 'tar -xzf backup.tar.gz -C /restore' }] },
  { id: 'tar-t', category: 'archive', cmd: 'tar -tzf', desc: '압축을 풀지 않고 내용 목록만 봅니다.', examples: [{ cmd: 'tar -tzf backup.tar.gz' }] },
  { id: 'zip', category: 'archive', cmd: 'zip -r', desc: '디렉터리를 zip 으로 묶습니다.', examples: [{ cmd: 'zip -r site.zip ./dist' }] },
  { id: 'unzip', category: 'archive', cmd: 'unzip', desc: 'zip 압축을 풉니다.', examples: [{ cmd: 'unzip site.zip -d ./out' }] },
  { id: 'gzip', category: 'archive', cmd: 'gzip', desc: '파일 하나를 gzip 으로 압축합니다(원본 삭제).', examples: [{ cmd: 'gzip access.log' }] },

  // ── 검색 ──
  { id: 'find-name', category: 'search', cmd: 'find -name', desc: '이름 패턴으로 파일을 찾습니다.', examples: [{ cmd: "find /var/log -name '*.log'" }] },
  { id: 'find-exec', category: 'search', cmd: 'find -exec', desc: '찾은 파일마다 명령을 실행합니다.', examples: [{ cmd: "find /var/log -name '*.log' -mtime +30 -exec rm {} \\;" }], caution: '삭제 명령과 함께 쓰면 되돌릴 수 없습니다 — 먼저 -exec 없이 결과를 확인하세요.' },
  { id: 'find-mtime', category: 'search', cmd: 'find -mtime', desc: '수정 시각 기준으로 파일을 찾습니다.', examples: [{ cmd: 'find /tmp -mtime +7 -type f' }] },
  { id: 'grep-r', category: 'search', cmd: 'grep -rn', desc: '디렉터리 전체에서 줄 번호와 함께 문자열을 찾습니다.', examples: [{ cmd: "grep -rn 'TODO' ./src" }] },
  { id: 'which', category: 'search', cmd: 'which', desc: '명령어의 실행 경로를 찾습니다.', examples: [{ cmd: 'which node' }] },
  { id: 'locate', category: 'search', cmd: 'locate', desc: '미리 만들어진 색인으로 매우 빠르게 파일을 찾습니다.', examples: [{ cmd: 'locate nginx.conf' }] },

  // ── 텍스트처리 ──
  { id: 'grep', category: 'text', cmd: 'grep -i', desc: '대소문자 구분 없이 패턴을 찾습니다.', examples: [{ cmd: "grep -i 'error' app.log" }] },
  { id: 'sed', category: 'text', cmd: "sed 's/…/…/g'", desc: '파일 내 문자열을 치환합니다.', examples: [{ cmd: "sed -i 's/8080/9090/g' config.yml" }], caution: '-i 는 원본을 직접 덮어씁니다 — 먼저 백업하세요.' },
  { id: 'awk', category: 'text', cmd: "awk '{print $1}'", desc: '공백으로 나눈 필드를 뽑아냅니다.', examples: [{ cmd: "ps aux | awk '{print $2, $11}'" }] },
  { id: 'cut', category: 'text', cmd: 'cut -d -f', desc: '구분자로 나눈 특정 필드만 자릅니다.', examples: [{ cmd: "cut -d: -f1 /etc/passwd" }] },
  { id: 'sort', category: 'text', cmd: 'sort -rh', desc: '사람이 읽는 단위(K/M/G)를 인식해 역순 정렬합니다.', examples: [{ cmd: 'du -sh * | sort -rh' }] },
  { id: 'uniq', category: 'text', cmd: 'uniq -c', desc: '중복 줄을 세어 하나로 합칩니다(정렬 후 사용).', examples: [{ cmd: 'sort access.log | uniq -c | sort -rn' }] },
  { id: 'wc', category: 'text', cmd: 'wc -l', desc: '줄 수를 셉니다.', examples: [{ cmd: 'cat access.log | wc -l' }] },
  { id: 'head', category: 'text', cmd: 'head -n', desc: '파일의 앞 N 줄만 봅니다.', examples: [{ cmd: 'head -n 50 app.log' }] },
  { id: 'tail-f', category: 'text', cmd: 'tail -f', desc: '파일에 새로 추가되는 내용을 실시간으로 따라갑니다.', examples: [{ cmd: 'tail -f app.log' }] },
  { id: 'less', category: 'text', cmd: 'less', desc: '큰 파일을 스크롤하며 봅니다(끝까지 읽지 않아도 빠릅니다).', examples: [{ cmd: 'less app.log' }] },
  { id: 'diff', category: 'text', cmd: 'diff -u', desc: '두 파일의 차이를 unified 형식으로 봅니다.', examples: [{ cmd: 'diff -u old.conf new.conf' }] },
  { id: 'xargs', category: 'text', cmd: 'xargs', desc: '표준입력의 각 줄을 다음 명령의 인자로 넘깁니다.', examples: [{ cmd: "find . -name '*.tmp' | xargs rm" }], caution: '삭제 명령과 조합하면 되돌릴 수 없습니다.' },
  { id: 'jq', category: 'text', cmd: 'jq', desc: 'JSON 을 파싱하고 필드를 뽑아냅니다.', examples: [{ cmd: "curl -s https://api.example.com/status | jq '.ok'" }] },

  // ── tmux (FB-monitor: FB-0004 — 사용법을 몰라 못 쓴다는 피드백) ──
  // prefix 키(기본 Ctrl+b)로 시작하는 조작에도 대응하는 명령줄이 대부분 있다 — [터미널로 보내기]로
  // 그대로 실행되는 셸 명령 위주로 적고, 키 조합은 desc/cmd 에 병기한다.
  { id: 'tmux-new', category: 'tmux', cmd: 'tmux new -s', desc: '이름 있는 새 세션을 만듭니다. 접속이 끊겨도 세션은 서버에 계속 살아 있습니다.', examples: [{ cmd: 'tmux new -s work' }] },
  { id: 'tmux-ls', category: 'tmux', cmd: 'tmux ls', desc: '현재 실행 중인 세션 목록을 봅니다(사이드바 트리 우클릭 → tmux 에서도 바로 보입니다).', examples: [{ cmd: 'tmux ls' }] },
  { id: 'tmux-attach', category: 'tmux', cmd: 'tmux attach -t', desc: '기존 세션에 다시 붙습니다(짧게 tmux a -t 도 됩니다) — 접속이 끊겼다가 돌아왔을 때 씁니다.', examples: [{ cmd: 'tmux attach -t work' }] },
  { id: 'tmux-detach', category: 'tmux', cmd: 'Ctrl+b d', desc: 'prefix(Ctrl+b) 다음 d — 세션을 끄지 않고 빠져나옵니다. 안의 프로그램은 계속 돕니다.', examples: [{ cmd: 'tmux detach' }] },
  { id: 'tmux-window-new', category: 'tmux', cmd: 'Ctrl+b c', desc: '새 창(window)을 만듭니다 — 세션 하나 안에 여러 창을 둘 수 있습니다.', examples: [{ cmd: 'tmux new-window' }] },
  { id: 'tmux-window-switch', category: 'tmux', cmd: 'Ctrl+b n / p', desc: '다음(n) · 이전(p) 창으로 이동합니다.', examples: [{ cmd: 'tmux next-window' }, { cmd: 'tmux previous-window' }] },
  { id: 'tmux-pane-split', category: 'tmux', cmd: 'Ctrl+b % / "', desc: '현재 창을 세로(%)·가로(") 로 나눠 창(pane)을 만듭니다.', examples: [{ cmd: 'tmux split-window -h', note: '세로 분할' }, { cmd: 'tmux split-window -v', note: '가로 분할' }] },
  { id: 'tmux-pane-switch', category: 'tmux', cmd: 'Ctrl+b 방향키', desc: '나뉜 창(pane) 사이를 화살표 방향키로 이동합니다.', examples: [{ cmd: 'tmux select-pane -D', note: '아래쪽 pane 으로' }] },
  { id: 'tmux-rename', category: 'tmux', cmd: 'tmux rename-session -t', desc: '세션 이름을 바꿉니다(대상이 여러 개일 때 구분하기 좋습니다).', examples: [{ cmd: 'tmux rename-session -t 0 work' }] },
  { id: 'tmux-kill', category: 'tmux', cmd: 'tmux kill-session -t', desc: '세션을 완전히 종료합니다(안의 프로그램도 함께 종료).', examples: [{ cmd: 'tmux kill-session -t work' }], caution: '세션 안 프로그램이 저장하지 않은 작업과 함께 종료됩니다.' }
] as const

// 검색: 명령·설명 부분일치(대소문자 무시). 빈 질의는 전체 반환.
export function searchCommandBook(entries: readonly CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter((e) => e.cmd.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))
}
