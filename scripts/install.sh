#!/bin/sh

set -eu

package_name='@xfq/froe'
required_major=22

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "froe requires Node.js ${required_major} or later. Install it from https://nodejs.org/ and run this command again." >&2
  exit 1
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  ''|*[!0-9]*)
    printf '%s\n' 'Unable to determine the installed Node.js version.' >&2
    exit 1
    ;;
esac

if [ "$node_major" -lt "$required_major" ]; then
  printf '%s\n' "froe requires Node.js ${required_major} or later; found $(node --version). Install a newer Node.js version from https://nodejs.org/." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm is required to install froe. Install a Node.js distribution that includes npm and run this command again.' >&2
  exit 1
fi

npm install --global "$package_name"
printf '%s\n' 'froe is installed. Run `froe` from the repository you want it to work in.'
