# CraftYap 배포 가이드 (craftyap.com)

poke와 **같은 서버**에서, **포트·앱 디렉터리·DB를 완전히 분리**해 나란히 돌립니다.
- 컨테이너: `127.0.0.1:8082` (poke는 3000 — 겹치지 않음)
- 앱 디렉터리: `/srv/craftyap/app`
- **DB(별도 관리)**: `/srv/craftyap/data/records.db` — poke의 Postgres와 무관한 독립 SQLite 파일. 백업·삭제를 따로 함.
- nginx: 호스트의 기존 nginx에 vhost 하나 추가 (poke 설정 안 건드림)

호스트 IP: `172.236.235.9` (poke와 동일)

---

## 1. DNS (도메인 등록업체에서)
`craftyap.com`, `www.craftyap.com` 둘 다 A 레코드를 서버 IP로:
```
craftyap.com.       A   172.236.235.9
www.craftyap.com.   A   172.236.235.9
```
전파 확인: `dig +short craftyap.com` → `172.236.235.9`

## 2. 서버에 코드 올리기 (deploy 유저로 SSH)
```bash
sudo install -d -o deploy -g deploy /srv/craftyap/app /srv/craftyap/data /srv/craftyap/logs
# 방법 A) git
git clone <레포URL> /srv/craftyap/app
# 방법 B) 로컬에서 rsync (node_modules/dist 제외)
#   rsync -az --exclude node_modules --exclude '**/dist' ./ deploy@172.236.235.9:/srv/craftyap/app/
cd /srv/craftyap/app
cp .env.example .env      # 필요시 편집 (기본값 그대로도 동작)
```

## 3. 앱 먼저 기동 (nginx가 프록시할 대상)
```bash
cd /srv/craftyap/app
bash scripts/deploy.sh          # → Health check passed
curl -s http://127.0.0.1:8082/healthz   # ok
```

## 4. nginx — 부트스트랩(HTTP) → 인증서 → 풀(TLS) 순서
> **중요**: craftyap.com vhost가 없으면 요청이 포트의 첫 server 블록(=포켓몬)으로
> 넘어갑니다. 또 풀 vhost는 아직 없는 인증서를 참조하므로 `nginx -t`가 실패합니다.
> 그래서 **HTTP 부트스트랩 → 인증서 발급 → 풀 vhost 교체** 순서로 진행합니다.

```bash
# (a) 부트스트랩: craftyap.com을 HTTP로 먼저 점유 (포켓몬으로 안 새게)
sudo mkdir -p /var/www/craftyap
sudo cp /srv/craftyap/app/ops/nginx/craftyap.com.bootstrap.conf \
        /etc/nginx/sites-available/craftyap.com.conf
sudo ln -sf /etc/nginx/sites-available/craftyap.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
#   → 이 시점에서 http://craftyap.com 은 이미 우리 게임을 띄웁니다.

# (b) 인증서 발급 (HTTP-01, 위 webroot 사용)
sudo certbot certonly --webroot -w /var/www/craftyap \
        -d craftyap.com -d www.craftyap.com

# (c) 풀 TLS vhost로 교체 (인증서가 생겼으니 경로가 유효)
sudo cp /srv/craftyap/app/ops/nginx/craftyap.com.conf \
        /etc/nginx/sites-available/craftyap.com.conf
sudo nginx -t && sudo systemctl reload nginx
```
이후 `https://craftyap.com` → 우리 게임, 정식 인증서로 로드됩니다.

## 5. 검증
```bash
node tools/smoke-prod.mjs https://craftyap.com   # 전 구간 10개 체크
```

---

## 자동 배포 (GitHub Actions — poke와 동일 방식)
`.github/workflows/deploy.yml`이 main push 시 러너에서 SSH로 배포합니다.
**최초 1회 세팅**:
1. GitHub 저장소 생성 후 push (`github.com/yoo9857/yap`).
2. 저장소 Settings → Secrets and variables → Actions 에 2개 추가:
   - `DEPLOY_SSH_KEY` — `root@172.236.235.9`에 등록된 개인키 (poke와 같은 키 사용 가능)
   - `DEPLOY_KNOWN_HOSTS` — `ssh-keyscan -t ed25519,rsa 172.236.235.9` 출력
3. 서버에 저장소를 clone하고 위 §3~§4 최초 부트스트랩(앱 기동 + 인증서 + vhost)을 1회 수행:
   ```bash
   git clone https://github.com/yoo9857/yap.git /srv/craftyap/app
   cd /srv/craftyap/app && cp .env.example .env
   # 이후 §3(앱 기동) → §4(부트스트랩→인증서→풀 vhost)
   ```
이후로는 **`git push`만 하면** test(typecheck+test) 통과 시 자동 빌드·재기동·nginx 반영·헬스체크까지 끝납니다.

## 수동 업데이트 (CI 없이)
```bash
cd /srv/craftyap/app
git pull
bash scripts/deploy.sh   # --build 포함, 무중단에 가깝게 교체
```

## DB (별도 관리 — 중요)
poke와 절대 공유하지 않는 독립 SQLite입니다. 위치: `/srv/craftyap/data/`
```bash
# 백업 (WAL 포함 안전 복사)
sudo sqlite3 /srv/craftyap/data/records.db ".backup '/srv/craftyap/data/records-$(date +%F).db'"
# 초기화 (리더보드 전체 삭제) — 컨테이너 정지 후
cd /srv/craftyap/app && docker compose down
sudo rm -f /srv/craftyap/data/records.db*      # -shm/-wal 포함
docker compose up -d
```

## 배포 직후 스모크 테스트
```bash
# 컨테이너(로컬 포트) 대상
node tools/smoke-prod.mjs http://127.0.0.1:8082
# 공개 도메인 대상 (TLS/nginx/WS 포함 전 구간)
node tools/smoke-prod.mjs https://craftyap.com
```
health·정적 MIME·캐시 헤더·OG 태그·`/ws` 핸드셰이크까지 한 번에 확인합니다.

## DB 백업 (cron 등록 권장)
```bash
# 수동 실행
bash scripts/backup-db.sh
# 매일 04:30 자동 (crontab -e)
30 4 * * * /srv/craftyap/app/scripts/backup-db.sh >> /srv/craftyap/logs/backup.log 2>&1
```
`/srv/craftyap/backups/`에 gz로 14일 보관. poke 백업과 완전히 별개입니다.

## TLS 자동 갱신
`certbot`은 설치 시 systemd 타이머로 자동 갱신됩니다. 확인:
```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

## 상태 확인 / 로그
```bash
cd /srv/craftyap/app
docker compose ps
docker compose logs -f --tail=100 app
curl -s http://127.0.0.1:8082/healthz    # → ok
```

## 참고 — 왜 이 구조인가
- 앱이 정적 파일 + WebSocket(`/ws`)을 **한 포트(8081, 컨테이너 내부)**에서 서빙 → nginx는 단순 프록시만.
- `@robo/shared`는 tsup가 서버 번들에 인라인 → 런타임 의존성은 `better-sqlite3/pino/ws/zod` 4개뿐이라 이미지가 가볍습니다.
- `node:22-slim`(glibc) 사용 → better-sqlite3 prebuilt 바이너리, 빌드 도구 불필요.
- SQLite가 깨지면 앱은 in-memory로 폴백(리더보드 비영속) — 서비스는 죽지 않음.
