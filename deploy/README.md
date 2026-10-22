# Deploying to a DigitalOcean droplet behind Tailscale

The bot and dashboard run 24/7 on a small Ubuntu server. The dashboard is never on the
public internet: it listens on localhost and is published only inside your Tailscale network.

## 0. Before you start (on this Mac)

- Install Tailscale on the Mac and phone from https://tailscale.com/download and sign in once.
- You already have an SSH key at `~/.ssh/id_ed25519.pub`. You will paste it into DigitalOcean.

## 1. Create the droplet (DigitalOcean console)

- Region: Sydney (SYD1). Image: Ubuntu 24.04 LTS. Plan: the smallest Basic shared CPU
  (1 vCPU, 1 GB) is enough. Authentication: SSH key, paste the contents of `~/.ssh/id_ed25519.pub`.
- Hostname: `memecoinbot`. Note the public IP once it is created.

## 2. Bootstrap the server (once)

```bash
scp deploy/bootstrap.sh root@<droplet-ip>:/root/
ssh root@<droplet-ip> bash /root/bootstrap.sh
```

This installs Node 24, PM2, Tailscale, locks the firewall to SSH plus Tailscale, disables
password and root SSH login, creates the `bot` user, and sets Sydney time. Then join the
tailnet. It prints a link; open it once in your browser and approve the machine:

```bash
ssh root@<droplet-ip> tailscale up --ssh=false
```

After this step, log in as `bot@<droplet-ip>`; root login is disabled.

## 3. Move the paper week to the server

Stop the Mac bot first so two copies never trade the same ledger, then push the code and the
ledger and start everything on the server:

```bash
npx pm2 stop memecoinbot memecoinbot-ui memecoinbot-keepawake
bash deploy/deploy.sh bot@<droplet-ip> --with-ledger
```

The deploy script syncs the code (never `.env`, logs, or node_modules), installs dependencies,
builds the dashboard, and starts or restarts the three PM2 apps. Later code changes are the same
command without `--with-ledger`. The server's `.env` is created from `.env.example` on the first
deploy; edit it on the server with `nano ~/memecoinbot/.env` to add an Anthropic key if wanted.

## 4. Publish the dashboard inside the tailnet

```bash
ssh bot@<droplet-ip> sudo tailscale serve --bg 4777
```

Open `https://memecoinbot.<your-tailnet>.ts.net` on any device signed in to Tailscale. The
exact name is printed by `tailscale status`. Turn Tailscale off on the phone and the address
stops working, which is the privacy guarantee doing its job.

## Day to day

```bash
ssh bot@<droplet-ip>
pm2 ls                               # three apps online (two on Linux: no keep-awake)
pm2 logs memecoinbot --lines 50
cd ~/memecoinbot && npm run status
cd ~/memecoinbot && npm run report -- --save
```

## What is and is not exposed

| Port | Public internet | Tailnet |
|---|---|---|
| 22 SSH | key only, root disabled, fail2ban | same |
| 4777 dashboard | closed (not listening publicly, firewall denies) | HTTPS via `tailscale serve` |
| anything else | denied by ufw | allowed on `tailscale0` only |

## Rolling back to the Mac

Stop the server apps (`pm2 stop all`), copy the ledger back
(`scp bot@<ip>:memecoinbot/data/memecoinbot.db data/`), and `npx pm2 start ecosystem.config.cjs` here.
