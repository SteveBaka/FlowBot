FROM ubuntu:22.04

# apt-cacher-ng proxy (optional, pass --build-arg APT_PROXY=http://host:3142 to enable)
ARG APT_PROXY=""
RUN if [ -n "$APT_PROXY" ]; then \
      printf 'Acquire::http::Proxy "%s";\n' "$APT_PROXY" > /etc/apt/apt.conf.d/01proxy; \
    fi

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV NODE_ENV=production
ENV ONEBOT_PORT=7100
ENV VNC_PORT=5900
ENV WEBUI_PORT=7300
ENV WEFLOW_DOCKER=1
ENV TZ=Asia/Shanghai

# Set timezone to Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo 'Asia/Shanghai' > /etc/timezone

# Install Node.js runtime from the official tarball (pinned, reproducible).
# npm/corepack stripped: only the node binary is needed (WebUI server.js).
ARG NODE_VERSION=22.23.2
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
        | tar -xJ --strip-components=1 -C /usr/local \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/share/doc /usr/local/share/man \
    && node --version

# Install system dependencies.
# --no-install-recommends skips: gcc/g++/python3-dev toolchain (via python3-pip),
# tilix/libgtkd/libllvm11 chain, mesa VA/VDPAU drivers (no GPU passthrough in container),
# perl helpers, icon themes — none are used at runtime.
# No apt ffmpeg: the app bundles statically-linked ffmpeg-static; WeChat ships its
# own codecs (verified: ldd shows no system libav linkage).
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps psmisc coreutils tzdata \
    fluxbox \
    xvfb x11vnc \
    libgtk-3-0 libgbm1 libnss3 libxss1 libasound2 \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
    libcairo2 libdbus-1-3 libnspr4 libsecret-1-0 libnotify4 \
    libatomic1 libpulse0 libxkbcommon0 libxkbcommon-x11-0 \
    libgssapi-krb5-2 libudev1 \
    libxcb-icccm4 libxcb-util1 libxcb-keysyms1 libxcb-image0 \
    libxcb-render-util0 libxcb-xkb1 libxcb-shape0 libxcb-xfixes0 \
    libxcb-shm0 libxcb-sync1 libxcb-randr0 libxcb-glx0 \
    libxrender1 libxtst6 libxfixes3 libxext6 libx11-xcb1 \
    libxkbfile1 \
    xclip xdotool x11-utils x11-xserver-utils x11-apps xsel \
    dbus dbus-x11 \
    fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk \
    wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install WeChat for Linux
# 版本：4.1.13.23（SteveBaka/something-backup 备份包，GitHub Actions 可稳定拉取）。
# 2026-10-01 在独立容器完成兼容性验证并通过：GUI 启动/登录、DB 密钥 hook
# （com.Tencent.WCDB.Config.Cipher）、UI 自动化发送（xdotool+xclip）、
# 图片密钥管线（kvcomm→xorKey/aesKey）、hdDat 懒下载时序。
# 如需覆盖某次构建可用 --build-arg WECHAT_URL=<url>。
ARG WECHAT_URL=https://github.com/SteveBaka/something-backup/releases/download/4.1.13.23/somechat-Linux_x86_64-4.1.13.23.deb
RUN wget -q -O /tmp/wechat.deb "${WECHAT_URL}" \
    && dpkg -i /tmp/wechat.deb || apt-get install -y --no-install-recommends -f \
    && rm -f /tmp/wechat.deb \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /opt/wechat/wechat /usr/bin/wechat \
    && chmod +x /opt/wechat/wechat

# Python3 for pinyin group-name search + websockify from PyPI (the apt package
# hard-depends on python3-numpy/oslo chain). PyPI websockify declares numpy/
# requests/jwcrypto/redis but its core WS<->TCP relay imports them optionally
# (verified in source: numpy is try/except-guarded, others are lazy token-plugin
# imports we never use) — so install with --no-deps to keep numpy out.
# noVNC from the official static tarball (apt novnc also hard-depends numpy).
ARG NOVNC_VERSION=1.5.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install --no-cache-dir --no-deps pypinyin websockify==0.13.0 \
    && wget -q -O /tmp/novnc.tar.gz \
        "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
    && mkdir -p /opt/novnc \
    && tar -xzf /tmp/novnc.tar.gz -C /opt/novnc --strip-components=1 \
    && printf '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=./vnc.html">\n<title>noVNC</title>\n</head>\n<body style="margin:0;padding:0">\n<a href="./vnc.html" style="display:block;text-align:center;padding:40px;font:16px sans-serif">正在进入 noVNC…（若未跳转请点击）</a>\n</body>\n</html>\n' > /opt/novnc/index.html \
    && rm -f /tmp/novnc.tar.gz \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -c "import pypinyin" \
    && ! python3 -c "import numpy" \
    && websockify --help >/dev/null

# Copy pre-built Electron app (WeFlow HTTP API on port 5031)
WORKDIR /opt/weflow
COPY release/linux-unpacked/ ./
RUN chmod +x ./weflow *.so *.node 2>/dev/null; chmod +x swiftshader/*.so 2>/dev/null; true

# Align libwcdb_api.so software deadline with the local-attestation cap: the instant is
# read from resources/attest/linux/x64/attest_core (single source), never hardcoded here.
# After that instant wcdb_init returns -1000 and every DB-backed feature stops — intended:
# the attestation does not hard-block a running process, the native gate takes effect on
# the next (re)initialize (container restart). See scripts/patch-wcdb-deadline.py.
COPY scripts/patch-wcdb-deadline.py /opt/patch-wcdb-deadline.py
RUN python3 /opt/patch-wcdb-deadline.py --no-backup \
      /opt/weflow/resources/resources/wcdb/linux/x64/libwcdb_api.so \
    && python3 /opt/patch-wcdb-deadline.py --check \
      /opt/weflow/resources/resources/wcdb/linux/x64/libwcdb_api.so \
    && rm -rf /opt/weflow/resources/resources/wcdb/win32 \
              /opt/weflow/resources/resources/wcdb/macos

# Copy WebUI Vue SPA + server (port 7300, proxies to WeFlow API)
COPY docker/webui/ /opt/weflow-webui/

# Copy container version marker
COPY docker/VERSION /opt/weflow/VERSION

# Copy startup script
COPY docker/start.sh /opt/start.sh
COPY docker/pinyin.py /opt/pinyin.py
RUN chmod +x /opt/start.sh

# Create directories
RUN mkdir -p /opt/weflow/data /root/.config

# Headless box: whatever invokes fbsetbg (fluxbox compiled-in default / style),
# make it a no-op — wallpaper is meaningless under Xvfb and fbsetbg pops an
# xmessage error dialog when no setter app exists. dpkg-divert keeps the original.
RUN dpkg-divert --local --rename --add /usr/bin/fbsetbg >/dev/null \
    && ln -sf /bin/true /usr/bin/fbsetbg

# 7100: OneBot, 5031: WeFlow API (internal), 7300: WebUI, 7600: noVNC
EXPOSE 7100 5031 7300 7600

VOLUME ["/opt/weflow/data", "/root/.config"]

CMD ["/opt/start.sh"]
