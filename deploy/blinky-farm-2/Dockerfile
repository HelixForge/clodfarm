# clodfarm for Long Haul: the farm image plus Godot 4 and Blender (both headless use only).
# Rebuild after an upstream image update: docker compose build --pull && docker compose up -d
FROM ghcr.io/matank001/clodfarm:latest
ARG GODOT_VERSION=4.7.2-stable
USER root
RUN cd /tmp \
 && curl -fsSLO https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.x86_64.zip \
 && curl -fsSL https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/SHA512-SUMS.txt \
      | grep " Godot_v${GODOT_VERSION}_linux.x86_64.zip$" | sha512sum -c - \
 && unzip -q Godot_v${GODOT_VERSION}_linux.x86_64.zip \
 && install -m 755 Godot_v${GODOT_VERSION}_linux.x86_64 /usr/local/bin/godot \
 && rm -f Godot_v${GODOT_VERSION}_linux.x86_64*
# Blender, headless (blender -b -P script.py): the farm models ships and stations as Python scripts that export .glb
# (runbook 15b). Pinned with a sha256 checked against two mirrors; download.blender.org refuses curl.
ARG BLENDER_VERSION=5.2.2
ARG BLENDER_SHA256=84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
RUN apt-get update && apt-get install -y --no-install-recommends libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 \
      libxkbcommon0 libsm6 libice6 libgl1 libegl1 libglu1-mesa libxext6 libwayland-client0 \
 && rm -rf /var/lib/apt/lists/* \
 && cd /tmp && f=blender-${BLENDER_VERSION}-linux-x64.tar.xz \
 && curl -fsSL -A "Mozilla/5.0" -o $f https://mirrors.ocf.berkeley.edu/blender/release/Blender${BLENDER_VERSION%.*}/$f \
 && echo "${BLENDER_SHA256}  $f" | sha256sum -c - \
 && mkdir -p /opt/blender && tar -xJf $f -C /opt/blender --strip-components=1 && rm -f $f \
 && ln -s /opt/blender/blender /usr/local/bin/blender
# farm-helpers UI patch (local, not upstream): helper minis on the farm scene. ./ui-patch/apply.sh reapplies it
# to a running container, e.g. after `clodfarm upgrade` installs a new release (runbook 15b)
COPY ui-patch /opt/ui-patch
RUN /opt/clodfarm/bin/python3 /opt/ui-patch/apply.py /opt/clodfarm/lib/python3.11/site-packages/clodfarm \
 && chmod 644 /opt/clodfarm/lib/python3.11/site-packages/clodfarm/farm_helpers.py
USER farm
