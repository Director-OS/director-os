#!/usr/bin/env bash
set -euo pipefail

if [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck disable=SC1090
	. "$HOME/.nvm/nvm.sh"
	nvm use --lts >/dev/null
fi

npm install
npm run typecheck
npm run lint
npm test
