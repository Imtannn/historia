#!/bin/bash
# Stop all Historia dev servers on ports 8765–8770.
set -e
killed=0
for port in 8765 8766 8767 8768 8769 8770; do
  for pid in $(lsof -ti :"$port" 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null && echo "Stopped PID $pid on port $port" && killed=$((killed + 1)) || true
  done
done
if [ "$killed" -eq 0 ]; then
  echo "No servers on ports 8765–8770."
else
  echo "Stopped $killed process(es)."
fi
