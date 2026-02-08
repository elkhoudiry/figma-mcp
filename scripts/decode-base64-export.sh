#!/bin/bash
# Decodes a base64 export from export_node_as_base64 MCP tool response to a binary file.
# Auto-detects whether the input file is JSON-wrapped (MCP overflow) or raw base64.
#
# Usage:
#   From file (auto-detect):   ./scripts/decode-base64-export.sh <file.txt> <output.png>
#   From raw base64 string:    ./scripts/decode-base64-export.sh --raw <base64-string> <output.png>
#   From stdin:                 echo '<base64>' | ./scripts/decode-base64-export.sh - <output.png>

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage:"
  echo "  $0 <file> <output-file>                    # auto-detects JSON-wrapped or raw base64"
  echo "  $0 --raw <base64-string> <output-file>     # raw base64 string as argument"
  echo "  echo '<base64>' | $0 - <output-file>       # base64 from stdin"
  exit 1
fi

if [ "$1" = "--raw" ]; then
  if [ -z "$3" ]; then
    echo "Usage: $0 --raw <base64-string> <output-file>"
    exit 1
  fi
  echo "$2" | base64 -d > "$3"
  echo "Saved: $3"
elif [ "$1" = "-" ]; then
  base64 -d > "$2"
  echo "Saved: $2"
else
  if [ ! -f "$1" ]; then
    echo "File not found: $1"
    exit 1
  fi
  python3 -c "
import json, base64, sys

with open(sys.argv[1], 'r') as f:
    content = f.read().strip()

# Auto-detect: JSON-wrapped starts with '[', raw base64 starts with alphanumeric
if content.startswith('['):
    data = json.loads(content)
    raw = base64.b64decode(data[0]['text'])
else:
    raw = base64.b64decode(content)

with open(sys.argv[2], 'wb') as out:
    out.write(raw)
print('Saved: {} ({} bytes)'.format(sys.argv[2], len(raw)))
" "$1" "$2"
fi
