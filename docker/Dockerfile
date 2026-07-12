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

# Install Node.js 22.x
RUN apt-get update && apt-get install -y \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install system dependencies
RUN apt-get update && apt-get install -y \
    procps psmisc coreutils tzdata \
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
    ffmpeg \
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

# Install Python3 + pinyin support for Chinese group name search
RUN apt-get update && apt-get install -y python3 python3-pip \
    && pip3 install pypinyin \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built Electron app (WeFlow HTTP API on port 5031)
WORKDIR /opt/weflow
COPY release/linux-unpacked/ ./
RUN chmod +x ./weflow *.so *.node 2>/dev/null; chmod +x swiftshader/*.so 2>/dev/null; true

# Copy WebUI Vue SPA + server (port 7300, proxies to WeFlow API)
COPY docker/webui/ /opt/weflow-webui/

# Copy startup script
COPY docker/start.sh /opt/start.sh
COPY docker/pinyin.py /opt/pinyin.py
RUN chmod +x /opt/start.sh

# Create directories
RUN mkdir -p /opt/weflow/data /root/.config

# 7100: OneBot, 5031: WeFlow API (internal), 7300: WebUI, 7600: noVNC
EXPOSE 7100 5031 7300 7600

VOLUME ["/opt/weflow/data", "/root/.config"]

CMD ["/opt/start.sh"]
