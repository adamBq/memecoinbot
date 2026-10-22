#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 droplet for memecoinbot.
# Run as root:  bash bootstrap.sh
# Creates the "bot" user, installs Node 24, PM2, Tailscale, locks the firewall to SSH + Tailscale,
# sets Sydney time, and leaves the box ready for deploy.sh from your Mac.
set -euo pipefail

BOT_USER="bot"
NODE_MAJOR="24"
TZ_NAME="Australia/Sydney"

log() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "System packages and timezone"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw unattended-upgrades ca-certificates gnupg rsync fail2ban
timedatectl set-timezone "$TZ_NAME"

log "Swap (1 GB) so npm ci and the dashboard build never get killed on a 1 GB droplet"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

log "Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

log "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

log "Bot user"
if ! id -u "$BOT_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$BOT_USER"
fi
install -d -m 700 -o "$BOT_USER" -g "$BOT_USER" "/home/$BOT_USER/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "/home/$BOT_USER/.ssh/authorized_keys"
  chown "$BOT_USER:$BOT_USER" "/home/$BOT_USER/.ssh/authorized_keys"
  chmod 600 "/home/$BOT_USER/.ssh/authorized_keys"
fi
install -d -o "$BOT_USER" -g "$BOT_USER" "/home/$BOT_USER/memecoinbot"
# Limited sudo: only the Tailscale CLI, which is needed for "tailscale up" and "tailscale serve".
printf '%s ALL=(ALL) NOPASSWD: /usr/bin/tailscale\n' "$BOT_USER" > /etc/sudoers.d/90-bot-tailscale
chmod 440 /etc/sudoers.d/90-bot-tailscale
visudo -cf /etc/sudoers.d/90-bot-tailscale >/dev/null

log "SSH hardening: keys only, no root login"
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
# Ubuntu cloud images may ship an override that re-enables passwords.
if ls /etc/ssh/sshd_config.d/*.conf >/dev/null 2>&1; then
  sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config.d/*.conf || true
fi
systemctl restart ssh || systemctl restart sshd

log "Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled

log "Firewall: SSH in, everything on the Tailscale interface, deny the rest"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow in on tailscale0
ufw --force enable
ufw status verbose

log "PM2 (global) and log rotation"
npm install -g pm2@6
sudo -u "$BOT_USER" -H bash -c 'pm2 install pm2-logrotate >/dev/null && pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14'
# Start PM2 for the bot user at boot (systemd unit).
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$BOT_USER" --hp "/home/$BOT_USER" >/dev/null

log "Done. Next steps:"
cat <<MSG
  1. Join this box to your Tailscale network (prints a login link to open once):
       sudo tailscale up --ssh=false      (as the bot user; root SSH is now disabled)
  2. From your Mac, deploy the code and start the bot:
       bash deploy/deploy.sh bot@<droplet-public-ip> --with-ledger
  3. Publish the dashboard inside your tailnet only (HTTPS, no public port):
       sudo tailscale serve --bg 4777
     then open https://$(hostname).<your-tailnet>.ts.net from any device signed in to Tailscale.
MSG
