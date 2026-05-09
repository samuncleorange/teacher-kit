# 部署 coturn 作为 TURN 中转（5 分钟版）

> 当 P2P 直连失败时（对称 NAT、运营商封 UDP、企业防火墙等），WebRTC 会自动改走 TURN 服务器中转。本仓库前端已支持这一兜底逻辑——你只需要部署一个 TURN 服务器，并把它的 URL/凭据填进老师端的「TURN 中转配置」即可。
>
> 推荐用 [coturn](https://github.com/coturn/coturn)：业界标准、Debian/Ubuntu 一行 apt 装好、单机轻量、稳如磐石。

---

## 0. 适用场景

- ✅ 你已有一台 Linux 服务器，跑了本仓库 `server.py` + nginx/Caddy 反代
- ✅ 服务器有公网 IP（IPv4 即可），并且能开放至少两个端口
- ✅ 想让"偶尔需要的远程视频"走自家服务器的流量

如果你只在校园局域网用，P2P 通常就能直连，**不需要部署 TURN**。

---

## 1. 安装

```bash
sudo apt-get update
sudo apt-get install -y coturn
```

启用守护进程：

```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

---

## 2. 最简配置

把 `/etc/turnserver.conf` 改成下面的内容（替换 `你的域名` 和 `你的服务器公网IP`）：

```conf
# /etc/turnserver.conf

# 监听端口（标准 STUN/TURN 端口）
listening-port=3478
# 如果想用 TLS（强烈建议公网部署），取消注释下一行
# tls-listening-port=5349

# 服务器自己的公网地址（必填，让客户端拿到正确的 relay 地址）
external-ip=你的服务器公网IP

# 监听网卡（默认全部，单网卡机器不用改）
listening-ip=0.0.0.0

# realm：随便起个名（一般是域名）
realm=你的域名

# 长期凭据模式：用户名/密码硬编码
lt-cred-mech
user=quiet:你自己定义的强密码

# 日志（生产可改 /var/log/turnserver/）
log-file=/var/log/turnserver.log
no-stdout-log

# 安全：禁止内网中转，避免被滥用做 SSRF
no-loopback-peers
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.88.99.0-192.88.99.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=240.0.0.0-255.255.255.255

# 中转端口范围（防火墙需要放行 UDP 49152-65535）
min-port=49152
max-port=65535

# 默认带宽限制（512 kbps/会话，避免被白嫖）
user-quota=12
total-quota=120
```

---

## 3. 防火墙

```bash
# UDP 3478 + UDP 49152-65535（中转通道）
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49152:65535/udp
# 如果用了 tls-listening-port=5349
# sudo ufw allow 5349/tcp
```

云厂商安全组同样要放行这些端口。

---

## 4. 启动并验证

```bash
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
```

正常应看到 `Active: active (running)`。

用任意一个在线 TURN 测试器验证（如 https://icetest.info/ 或 https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/）：

- TURN URI: `turn:你的域名:3478?transport=udp`
- 用户名：`quiet`
- 密码：你自己设的密码

测试器应能收到 `relay` 类型的候选，颜色标识为绿色。

---

## 5. 填入老师端

打开 `https://你的域名/teacher/PIN`，展开「⚙ 高级：TURN 中转配置」：

| 字段 | 填什么 |
|---|---|
| TURN URI | `turn:你的域名:3478?transport=udp,turn:你的域名:3478?transport=tcp` |
| 用户名   | `quiet` |
| 凭据     | 你自己设的密码 |

保存后，下次远程视频通话时：

- ICE 仍**优先尝试 P2P 直连**（速度快、不占服务器流量）
- 直连失败时**自动 fall back 到 TURN 中转**
- 卡片右上角徽章实时显示 `🏠 直连`、`🌐 P2P 直连（穿透 NAT）`、或 `🛰 服务器中转（TURN）`

---

## 6. （可选）TLS / 与现有 HTTPS 共用证书

如果你已经用 Let's Encrypt 给主域名签了证，可以让 coturn 复用同一份证书：

```conf
# 在 /etc/turnserver.conf 末尾追加
tls-listening-port=5349
cert=/etc/letsencrypt/live/你的域名/fullchain.pem
pkey=/etc/letsencrypt/live/你的域名/privkey.pem
```

让 coturn 用户能读证书：

```bash
sudo usermod -aG ssl-cert turnserver
sudo chmod g+r /etc/letsencrypt/live/你的域名/privkey.pem
```

让 certbot 续签后自动 reload coturn：

```bash
echo 'systemctl reload coturn' | sudo tee /etc/letsencrypt/renewal-hooks/post/coturn-reload.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/coturn-reload.sh
```

老师端 TURN URI 升级为：

```
turns:你的域名:5349?transport=tcp
```

`turns:` 前缀（注意末尾 s）走 TLS，能穿透更多企业防火墙。

---

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 测试器看不到 `relay` 候选 | 防火墙 / 安全组没放 UDP 3478 + 49152-65535 |
| 看到 `relay` 但 401 | `user=`、`realm=` 不匹配老师端填的 |
| `external-ip` 错误 | 服务器是云上 NAT 的话，要填**公网 IP**而不是网卡 IP |
| 老师端徽章一直是 🛰 | 说明没走直连——可能是网络确实不能 P2P，这时 TURN 工作正常 |
| 流量飙高 | TURN 在中转音视频，正常；想限制的话用 `total-quota` 和 `user-quota` |

---

## 8. 不想自己装？

可以先用免费第三方 TURN（带宽有限，仅用于测试）：

```
TURN URI: turn:openrelay.metered.ca:80
用户名:    openrelayproject
凭据:      openrelayproject
```

> 该服务由第三方运营、有限速、随时可能下线。生产环境请自行部署 coturn。
