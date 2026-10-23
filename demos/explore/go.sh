#!/bin/bash
# Runs one exploration scenario (a folder with demo.json and prompts) without video; prints the run folder at the end.
# Usage: explore/go.sh <scenario-folder, relative to demos/>
cd "$(dirname "$0")/.." || exit 1
EXPLORE_DEMO="$PWD/$1" node recorder/run.mjs "$1"
