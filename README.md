# Deriv Digit Bot

Plain JavaScript bot for Deriv Digit Over 1 and Digit Under 8 with a realtime Socket.IO dashboard.

The bot has no paper-trading simulator. It connects to Deriv and can run against either a demo account or a real account. Use demo mode first, then only consider real mode after the demo logs prove the rules behave exactly as expected.

## What It Implements

- Node.js, `ws`, `express`, `socket.io`, no frontend framework, no TypeScript.
- Dashboard inputs for a single Deriv authorization token, optional account ID, seed, target, demo/real mode, guide filters, and strict bar filters.
- Demo/real mode selects which account type the bot requests from Deriv. If you pin an account ID, it must match the selected mode.
- The dashboard shows both the live Deriv account balance and the bot's session equity, so you can tell real funds from the seed-based strategy ledger.
- Session balance starts at the seed you enter. The bot uses contract profit/loss to update that session balance.
- The bot preloads recent tick history on start so it can evaluate the 20-digit window immediately instead of waiting for a fresh warmup.
- Volatility 100 Index symbol: `R_100`.
- Contracts: `DIGITOVER` barrier `1`, and `DIGITUNDER` barrier `8`.
- Last 20 digits are tracked. The bot chooses whichever condition has hit less often recently.
- Optional guide filters based on the attached Over-market notes:
  - Over 1 waits for current digit `1`, with digits `0` and `1` below 10 percent in the recent window.
  - Under 8 mirrors that logic by waiting for current digit `8`, with digits `8` and `9` below 10 percent.
  - Stability is checked against the previous 20-digit window when enough data exists.
  - Strict bar filters are available but disabled by default because they can block too many entries.
  - Guide filters are also disabled by default so the core growth/risky/martingale loop can trade without getting stuck in setup mode.

## Phase Logic

Growth mode:

- Base stake is 2 percent of session balance.
- Minimum stake is `$0.35`.
- When session balance reaches 2x the current floor, the bot enters Risky Jump.
- The first floor is the seed. A winning Risky Jump logs a new floor.

Risky Jump:

- One stake at 35 percent of current session balance.
- Win: log new floor and return to Growth mode.
- Loss: enter one-recovery Martingale if the remaining balance is at least 4x the current base stake.

Martingale:

- One stake at 2x the failed risky stake, capped at 40 percent of remaining session balance.
- Win: return to Growth mode.
- Loss: enter Rebuild mode.

Rebuild:

- Stake `$0.35`.
- Trade until the session balance reaches the original seed, then restart Growth mode.
- Stop if session balance drops below 50 percent of seed while in Rebuild mode.

Exit:

- Take profit: session balance is greater than or equal to target.
- Stop loss: session balance drops below seed x 0.5 while in Rebuild mode.
- Manual stop from the dashboard.

## Local Setup

```bash
cp .env.example .env
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Environment

```env
PORT=3000
DERIV_API_TOKEN=
DERIV_ACCOUNT_ID=
DERIV_APP_ID=
DERIV_API_BASE_URL=https://api.derivws.com
DEFAULT_MODE=demo
SYMBOL=R_100
CURRENCY=USD
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=change-this-before-deploying
MIN_STAKE=0.35
BASE_STAKE_PERCENT=0.02
RISKY_STAKE_PERCENT=0.35
MARTINGALE_CAP_PERCENT=0.40
WINDOW_SIZE=20
GUIDE_FILTERS=false
STRICT_BAR_FILTERS=false
```

`DERIV_API_TOKEN` is the main token the bot uses. `DERIV_APP_ID` must be the App ID from a new PAT application you registered on `developers.deriv.com`; do not reuse the old legacy `1089` App ID. `DERIV_ACCOUNT_ID` is optional and only needed if you want to pin a specific account instead of letting the bot pick the first active demo or real account that matches the selected mode.

## API Tokens

Create your token in the Deriv dashboard:

1. Log in to the Deriv account you want to use.
2. Open the API tokens area in your account settings/dashboard.
3. Create a token with the `trade` scope.
4. Open `developers.deriv.com`, register a new application of type `PAT`, and copy the new App ID into `DERIV_APP_ID`.
5. Add `account_manage` only if you plan to extend the app to create or reset accounts later.
6. Copy the token once and store it in `.env` or paste it into the dashboard for a one-off run.

The current API docs treat the token as general authorization, not as the demo/real switch. The bot uses the token to request your account list, then it selects a demo or real account by account type and requests an OTP for that account. If you know the exact account ID you want, put it in `DERIV_ACCOUNT_ID`. If you still see 401s after updating the token, the usual culprit is an old App ID or a PAT/OAuth app-type mismatch.

## Heroku Deployment

This repo now includes a `Procfile` and `app.json`, so you can deploy it with Heroku’s button flow instead of rebuilding a VPS every time you change a line.

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/wangari327/neoFX)

Heroku Button will prompt for the required config vars, then create the app from this repo. After the first deploy, keep iterating by pushing to GitHub and letting Heroku’s GitHub integration redeploy the `main` branch, or by using `git push heroku main`.

Quick manual setup:

```bash
heroku login
heroku create your-app-name
heroku config:set DERIV_API_TOKEN=your_token_here
heroku config:set DASHBOARD_PASSWORD=choose-a-strong-password
heroku git:remote -a your-app-name
git push heroku main
```

Open the app at:

```text
https://YOUR-APP.herokuapp.com
```

## DigitalOcean Deployment (Optional)

DigitalOcean pricing and size names can change. As of the current docs, Droplets start from low monthly tiers, and `doctl compute droplet create` requires a size and image flag. Check the price shown in your DigitalOcean account before creating the server.

The cleanest path is:

1. Push this repo to GitHub.
2. Clone it on the droplet.
3. Run one install command from inside the clone.

Example on the VPS:

```bash
git clone https://github.com/YOUR_NAME/deriv-digit-bot.git /opt/deriv-digit-bot
cd /opt/deriv-digit-bot
cp .env.example .env
nano .env
sudo bash scripts/install-on-vps.sh
```

After the script finishes, open:

```text
http://YOUR_DROPLET_IP:3000
```

If you use a private GitHub repo, the droplet needs Git access too. The easiest path is an SSH deploy key or an SSH clone URL.

For a quicker path from this Windows workspace, use:

```powershell
powershell -File .\scripts\deploy-to-droplet.ps1 -DropletIp YOUR_DROPLET_IP
```

That script uploads the project, runs the VPS bootstrap, installs Node.js 24 LTS, PM2, and the firewall rules, then starts the bot.

By default, it uses your local SSH setup. If you want to point it at a specific private key file, pass `-IdentityFile`. Example:

```powershell
powershell -File .\scripts\deploy-to-droplet.ps1 -DropletIp YOUR_DROPLET_IP -IdentityFile $env:USERPROFILE\.ssh\id_ed25519
```

It logs in with SSH key authentication, not a VPS password. The default remote user is `root`, and you can override it with `-SshUser` if you create a different account.

### 1. Install and authenticate `doctl` on your local machine

```bash
doctl auth init
doctl compute ssh-key list
```

If you do not have an SSH key in DigitalOcean yet:

```bash
ssh-keygen -t ed25519 -C "deriv-digit-bot"
doctl compute ssh-key import deriv-digit-bot --public-key-file ~/.ssh/id_ed25519.pub
doctl compute ssh-key list
```

### 2. Create the Ubuntu 22.04 Droplet

Replace `YOUR_SSH_KEY_ID` with the ID from `doctl compute ssh-key list`.

```bash
doctl compute droplet create deriv-digit-bot \
  --image ubuntu-22-04-x64 \
  --size s-1vcpu-1gb \
  --region nyc3 \
  --ssh-keys YOUR_SSH_KEY_ID \
  --wait
```

Get the IP and SSH in:

```bash
DROPLET_IP=$(doctl compute droplet get deriv-digit-bot --format PublicIPv4 --no-header)
ssh root@$DROPLET_IP
```

### 3. Clone and install

On the Droplet, clone the repo, create the env file, and run the install script:

```bash
git clone https://github.com/YOUR_NAME/deriv-digit-bot.git /opt/deriv-digit-bot
cd /opt/deriv-digit-bot
cp .env.example .env
nano .env
sudo bash scripts/install-on-vps.sh
```

That script installs Node.js 24 LTS, PM2, and UFW, opens port 3000, installs dependencies, and starts the app. The `pm2 startup` command prints one more command. Copy and run that printed command if your server asks for it.

Open the dashboard at `http://YOUR_DROPLET_IP:3000`.

## Safer Live Use

- Use a demo account first.
- Keep `DASHBOARD_PASSWORD` set on any public server.
- Do not paste a live authorization token into a dashboard served over plain HTTP on an untrusted network.
- A bot can execute faster than manual clicking, but it does not remove the house edge or streak risk.
