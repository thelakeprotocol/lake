#!/bin/sh
# Writes this machine's disk and memory where the Lake node shows them (GET /status, as "host"), so a check from outside
# can see what the containers can't. Run as root from cron, with the node's data volume (default: the sandbox's):
#   echo '*/5 * * * * root /opt/lake-sandbox/host-status.sh lake-sandbox_node' > /etc/cron.d/lake-host-status
VOLUME=${1:-lake-sandbox_node}
DIR=$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME" 2>/dev/null)
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "no volume $VOLUME" >&2; exit 1; }
OUT=$DIR/host-status.json
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
avail=$(awk '/MemAvailable/ { print int($2/1024) }' /proc/meminfo)
swap=$(awk '/SwapTotal/ { t=$2 } /SwapFree/ { f=$2 } END { print int((t-f)/1024) }' /proc/meminfo)
load=$(cut -d' ' -f1 /proc/loadavg)
printf '{"at":"%s","disk_used_pct":%s,"mem_available_mb":%s,"swap_used_mb":%s,"load1":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$disk" "$avail" "$swap" "$load" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
