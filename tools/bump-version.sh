#!/bin/sh
# Give the site a new version number so every browser (including the Quest) picks up
# the latest code. Run this before committing a change, from the project folder:
#   sh tools/bump-version.sh
set -e
cd "$(dirname "$0")/.."
NEW=$(date +%Y%m%d%H%M)
sed -i '' -E "s/\?v=[0-9]+/?v=$NEW/g; s/MUSEUM_VERSION = '[0-9]+'/MUSEUM_VERSION = '$NEW'/" index.html
printf '{ "version": "%s" }\n' "$NEW" > version.json
echo "Site version is now $NEW"
