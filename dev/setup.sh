#!/bin/sh
# The local WordPress craftish-care is built and tested against (dev/README.md). Laptop only,
# safe to rerun. The first `ddev start` asks for sudo once, to add the site to /etc/hosts.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/wordpress"
ddev start
if ! ddev wp core is-installed >/dev/null 2>&1; then
  ddev wp core download --skip-content --force
  ddev wp core install --url=https://kamaji-wp.ddev.site --title='Kamaji test' \
    --admin_user=admin --admin_password=admin --admin_email=dev@example.com --skip-email
  ddev wp theme install twentytwentyfive
fi
node "$here/../scripts/care-keys.mjs"
