#!/usr/bin/env bash
# Push the code from this Mac to the droplet and (re)start it under PM2.
#   bash deploy/deploy.sh bot@<host> [--with-ledger] [--dry-run]
# --with-ledger copies data/memecoinbot.db so the paper week continues on the server.
#   Stop the local bot first (npx pm2 stop memecoinbot) or two bots will trade the same ledger copy.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: deploy.sh user@host [--with-ledger] [--dry-run]"; exit 1; }
shift
WITH_LEDGER=0
DRY=""
for a in "$@"; do
  case "$a" in
    --with-ledger) WITH_LEDGER=1 ;;
    --dry-run) DRY="--dry-run" ;;
    *) echo "unknown flag $a"; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
REMOTE_DIR="memecoinbot"

if [ "$WITH_LEDGER" -eq 1 ] && npx pm2 jlist 2>/dev/null | grep -q '"name":"memecoinbot","pm2_env":{[^}]*"status":"online"'; then
  echo "local memecoinbot is still online under PM2; stop it first:  npx pm2 stop memecoinbot"
  exit 1
fi

echo "==> rsync code to $TARGET:$REMOTE_DIR"
# Excludes are anchored to the project root (leading slash) so "src/data" is never mistaken for "data".
rsync -az --delete $DRY \
  --exclude /node_modules --exclude /dist --exclude /ui/dist --exclude /.git --exclude /.claude \
  --exclude /data --exclude /logs --exclude /reports --exclude /e2e/artifacts --exclude /e2e/test-results \
  --exclude /.env --exclude '*.db' --exclude '*.db-*' \
  ./ "$TARGET:$REMOTE_DIR/"

if [ "$WITH_LEDGER" -eq 1 ]; then
  echo "==> checkpointing the ledger so the write-ahead log is folded into the .db file"
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/memecoinbot.db');console.log(JSON.stringify(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()));db.close()"
  echo "==> copying ledger"
  rsync -az $DRY data/memecoinbot.db "$TARGET:$REMOTE_DIR/data/" --rsync-path="mkdir -p $REMOTE_DIR/data && rsync"
fi

[ -n "$DRY" ] && { echo "dry run complete"; exit 0; }

echo "==> remote install, build, start"
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
cd ~/memecoinbot
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example (edit it to add ANTHROPIC_API_KEY if you want LLM scoring)"
fi
npm ci --no-audit --no-fund
npm run ui:build
mkdir -p data logs
if pm2 describe memecoinbot >/dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
sleep 5
pm2 ls
curl -s -m 10 http://127.0.0.1:4777/api/health || echo "dashboard not answering yet"
echo
REMOTE
echo "==> deployed"
