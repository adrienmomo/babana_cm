#!/bin/sh
# Dev server -- runs odoo-bin as user babana, with /etc/babana/babana.env loaded into its
# environment (never on the command line, where `ps` would show the secrets).
#
#   sh infra/devserver/odoo.sh -d babana -u babana --stop-after-init --no-http
#   sh infra/devserver/odoo.sh shell -d babana --no-http < services/odoo/scripts/seed.py
set -eu
CONF="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/odoo.conf"
ENV_FILE="${BABANA_ENV_FILE:-/etc/babana/babana.env}"
# A subcommand (shell, ...) must come before -c.
case "${1:-}" in
  -*|"") set -- -c "$CONF" "$@" ;;
  *) sub=$1; shift; set -- "$sub" -c "$CONF" "$@" ;;
esac
exec sudo -u babana sh -c 'set -a; . "$0"; set +a; cd /var/lib/babana; exec /opt/odoo/venv/bin/python /opt/odoo/18.0/odoo-bin "$@"' "$ENV_FILE" "$@"
