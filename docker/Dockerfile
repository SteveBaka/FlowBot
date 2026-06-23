FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV NODE_ENV=production
ENV ONEBOT_PORT=3001
ENV VNC_PORT=5900
ENV WEBUI_PORT=5099
ENV FLOW_API_PORT=5031
ENV WEFLOW_DOCKER=1

# Install Node.js 22.x
RUN apt-get update && apt-get install -y \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install system dependencies
RUN apt-get update && apt-get install -y \
    procps psmisc coreutils \
    fluxbox \
    xvfb x11vnc novnc websockify \
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
    xclip xdotool x11-utils x11-xserver-utils \
    dbus dbus-x11 \
    fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk \
    supervisor wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install WeChat for Linux
ARG WECHAT_URL=https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_x86_64.deb
RUN wget -q -O /tmp/wechat.deb "${WECHAT_URL}" \
    && dpkg -i /tmp/wechat.deb || apt-get install -f -y \
    && rm -f /tmp/wechat.deb \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /opt/wechat/wechat /usr/bin/wechat \
    && chmod +x /opt/wechat/wechat

# Copy pre-built Electron app (WeFlow HTTP API on port 5031)
WORKDIR /opt/weflow
COPY release/linux-unpacked/ ./

# Copy WebUI Vue SPA + server (port 5099, proxies to WeFlow API)
COPY docker/webui/ /opt/weflow-webui/

# Copy startup script
COPY docker/start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

# Create directories
RUN mkdir -p /opt/weflow/data /root/.config

# 3001: OneBot, 5031: WeFlow API (internal), 5099: WebUI, 6080: noVNC
EXPOSE 3001 5031 5099 6080

VOLUME ["/opt/weflow/data", "/root/.config"]

CMD ["/opt/start.sh"]
