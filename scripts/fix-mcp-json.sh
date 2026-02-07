#!/bin/bash
# Extracts the JSON data from an MCP response file and saves it as proper JSON.
# Usage: ./scripts/fix-mcp-json.sh <file.txt>
# Output: <file.txt.json>

if [ -z "$1" ]; then
  echo "Usage: $0 <mcp-response-file>"
  exit 1
fi

if [ ! -f "$1" ]; then
  echo "File not found: $1"
  exit 1
fi

python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
parsed = json.loads(data[0]['text'])
with open(sys.argv[1] + '.json', 'w') as f:
    json.dump(parsed, f, indent=2)
print(sys.argv[1] + '.json')
" "$1"
