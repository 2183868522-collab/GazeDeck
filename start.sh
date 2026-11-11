#!/bin/bash
# Serve the prototype locally (camera access requires localhost or https). Usage: ./start.sh [port]
cd "$(dirname "$0")" && uv run --no-project python serve.py "${1:-8917}"
