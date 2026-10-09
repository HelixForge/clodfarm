#!/usr/bin/env bash
# Reapply the farm-helpers UI patch to the clodfarm-game container (runbook section 15b). Needed after an image rebuild
# without ./image's patch step, or after `clodfarm upgrade` installs a new release into the workspace volume.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd -P)
docker cp "$D" clodfarm-game:/tmp/ui-patch
for pkg in $(docker exec clodfarm-game sh -c 'ls -d /opt/clodfarm/lib/python3*/site-packages/clodfarm \
               $(readlink -f /workspace/.farm/releases/current 2>/dev/null)/lib/clodfarm 2>/dev/null'); do
  docker exec -u root clodfarm-game python3 /tmp/ui-patch/apply.py "$pkg"
  docker exec -u root clodfarm-game chmod 644 "$pkg/farm_helpers.py" "$pkg/farm_controls.py"
done
docker exec -u root clodfarm-game rm -rf /tmp/ui-patch
docker exec clodfarm-game clodfarm upgrade --restart-ui
