# Deriv Digit Bot

Plain JavaScript bot for Deriv Digit Over 1 and Digit Under 8 with a realtime Socket.IO dashboard.

The bot has no paper-trading simulator. It connects to Deriv and can run against either a demo account or a real account. Use demo mode first, then only consider real mode after the demo logs prove the rules behave exactly as expected.

## What It Implements

- Node.js, `ws`, `express`, `socket.io`, no frontend framework, no TypeScript.
- Dashboard inputs for a single Deriv authorization token, optional account ID, seed, target, demo/real mode, volatility index, Auto-cycle settings, target sizing mode, digit strategy mode, invert signal, guide filters, strict bar filters, growth stairs, optional initial stake, profit aggression, and blind sniper settings.
- Demo/real mode selects which account type the bot requests from Deriv. If you pin an account ID, it must match the selected mode.
- The dashboard shows both the live Deriv account balance and the bot's session equity, so you can tell real funds from the seed-based strategy ledger.
- The dashboard also shows live analysis status, so you can see whether the bot is warming up, waiting for a setup, or already in a trade.
- Pause, resume, and end-run controls are built into the dashboard so you can freeze a run without losing its state.
- Optional MongoDB persistence keeps run summaries, trade logs, and resume snapshots across restarts and redeploys.
- A recent-runs table lets you review prior runs and reopen their event logs from the dashboard.
- Session balance starts at the seed you enter. The bot uses contract profit/loss to update that session balance.
- The bot preloads recent tick history on start so it can evaluate the 20-digit window immediately instead of waiting for a fresh warmup.
- If a trade attempt fails, the bot now pauses briefly and keeps analyzing instead of stopping outright on the first error.
- Growth stairs are selectable: off, profit stairs, or loss-pressure stairs.
- Profit stairs raise the growth stake floor after mini profit milestones.
- Loss-pressure stairs do the reverse: ordinary growth/profit-push losses raise a capped temporary tier, then ordinary wins cool it down or reset it before full martingale recovery takes over.
- Compact-target mode is enabled automatically when the target gap is 25 percent of seed or less. It uses a target-gap-aware profit gate and a `profit_push` plan to press harder near the close instead of waiting for a seed-sized risky-jump gate.
- Profit aggression is a 1-5 dashboard slider. Higher values start compact-target profit-push trades earlier, increase growth/profit pressure, and shorten risk cooldowns while still blocking snipes and martingale revenge during weak win-rate conditions.
- Auto-cycle mode is enabled by default when Auto mode is on. It repeats small seed-sized profit cycles instead of trying to solve the whole target in one long run.
- Auto-cycle uses the proven compact manual preset by default: Volatility 10, base Over 1 / Under 8, phased engine, loss-pressure stairs, profit aggression 4, and sniper marks at 25 and 50 if sniper is enabled.
- Auto-cycle defaults to seed x 10 percent cycle profit, seed x 5 percent cycle stake, and a 60 second cooldown before the next cycle starts. Example: `$10` seed targets `$11` per cycle with a `$0.50` stake floor; an overall `$5` profit goal becomes five `$1` banked cycles separated by cycle breaks.
- Auto-cycle treats the dashboard target as a banked-profit goal. Example: seed `$10`, target `$15` means stop after `$5` closed-cycle profit, not because active cycle equity reaches `$15`.
- Auto-cycle banks completed cycle profit, resets the active cycle ledger back to the original seed, then waits for the configured cycle cooldown before placing another contract. Banked profit is tracked separately and is not added to the next cycle's stakeable ledger.
- If a cycle struggles below seed for a long time, Auto-cycle can cut the loop early: after 60 cycle trades, a recovery to at least 50 percent of the cycle profit target is banked and restarted; after 100 cycle trades, a recovery back to seed recycles the cycle at break-even.
- Legacy Auto commander behavior is still available by disabling Auto-cycle. It can dynamically tune approved weapons after launch, starting in Scout/Grind and unlocking Pressure or Blast only when recovery debt is clear, win rate is acceptable, and enough profit sits above the protected floor.
- The dashboard includes an Auto decision ticker and a compact Auto log so you can see why Auto changed symbol, strategy, sniper, stairs, or aggression.
- Optional blind sniper overlay supports any number of comma-separated progress marks, including negative recovery marks. Each mark is one possible shot, with stake caps near the target so small-profit runs are not broken by a one-third-balance shot.
- Volatility index selector supports `R_100` and `R_10`.
- Target sizing selector supports the normal phased engine and experimental Bold-to-target sizing.
- Digit strategy selector supports the base Over 1 / Under 8 loop plus high-payout experimental modes.
- Invert digit signal flips the selected contract after the strategy chooses it. For example, base `Over 1` becomes `Under 2`, base `Under 8` becomes `Over 7`, high-risk `Over 7` becomes `Under 8`, and Digit Match becomes Digit Differs.
- Base contracts: `DIGITOVER` barrier `1`, and `DIGITUNDER` barrier `8`.
- Last 20 digits are tracked. The bot chooses whichever condition has hit less often recently.
- Optional guide filters based on the attached Over-market notes:
  - Over 1 waits for current digit `1`, with digits `0` and `1` below 10 percent in the recent window.
  - Under 8 mirrors that logic by waiting for current digit `8`, with digits `8` and `9` below 10 percent.
  - Stability is checked against the previous 20-digit window when enough data exists.
  - Strict bar filters are available but disabled by default because they can block too many entries.
  - Guide filters are also disabled by default so the core growth/risky/martingale loop can trade without getting stuck in setup mode.

## Digit Strategy Modes

These modes are selectable in the dashboard. Higher payout does not mean a positive edge by itself; it usually means a lower natural hit rate. Keep new combinations on demo until the logs prove they behave.

- Base Over 1 / Under 8: original strategy. It chooses the cooler side from the recent 20-digit window, then trades `DIGITOVER 1` or `DIGITUNDER 8`.
- High risk Over 7 / Under 2: trades the low-hit-rate, high-payout sides only when the recent window shows enough winning-side heat. For Over 7 this means 8/9 must be active; for Under 2 this means 0/1 must be active. A live $1, 1-tick proposal sample on June 25, 2026 paid about +365 percent on `R_10` and +355 percent on `R_100`.
- Digit Match Sniper: targets the coldest digit in the recent window with `DIGITMATCH`. The same sample paid about +770 percent on `R_10` and +733 percent on `R_100`, but the natural hit rate is much lower.

Live proposal comparison from the same sample:

- Base Over 1 / Under 8: `R_10` paid about +23 percent per stake; `R_100` paid about +22 percent.
- Extreme Over 7 / Under 2: `R_10` paid about +365 percent; `R_100` paid about +355 percent.
- Digit Match: `R_10` paid about +770 percent; `R_100` paid about +733 percent.

That makes `R_10` the better payout selector in the current sample, but the bot still treats both as selectable because market availability, timing, and actual tick behavior matter more than a one-time quote.

The extreme selector no longer uses the base strategy's "cooler side" rule. That rule is useful for avoiding crowded losing digits on the 80-percent style base contracts, but it is backwards for Over 7 / Under 2. Extreme mode now estimates the contract break-even hit rate from payout, then requires the winning side to be hot enough in the 20-digit, 10-digit, and 5-digit windows before it will enter.

## Target Sizing Modes

- Phased engine: the existing growth, profit-push, risky-jump, recovery, stairs, and optional sniper state machine.
- Bold to target: stakes from the remaining target gap divided by the current observed payout ratio, capped at the current session balance. It bypasses martingale, stairs, snipers, and risky jumps so the run is a cleaner target-or-stop test. Use demo first; this mode can stake a large part of the session when the remaining target gap is large relative to payout.

## Auto Mode

Auto mode is a bounded rule-based commander, not machine learning and not unlimited revenge trading.

By default, Auto runs in Auto-cycle mode. The user sets seed and total target; Auto converts that into repeated micro-runs. For example, seed `$10`, target `$15`, and default cycle profit `$1` means the bot runs five isolated `$10 -> $11` cycles. After each completed cycle, the active ledger resets to `$10`, the profit is banked toward the overall target, and the bot waits through the cycle cooldown before opening the next cycle. The next cycle does not compound from the prior cycle's banked profit.

Auto-cycle exits:

- Full cycle win: active cycle equity reaches seed plus cycle profit.
- Long struggle partial lock: the cycle has gone below seed, has lasted at least 60 trades, and recovers to at least 50 percent of the cycle profit target.
- Long struggle break-even recycle: the cycle has gone below seed, has lasted at least 100 trades, and recovers to seed.

The older dynamic Auto commander is still available when Auto-cycle is turned off. In that mode, the user still sets seed, target, and mode; Auto adjusts only approved controls inside hard caps.

Auto can switch:

- Volatility symbol: usually favors `R_10` because the current comparable digit payout is slightly richer.
- Digit strategy: base, high-risk Over 7 / Under 2, or Digit Match Sniper.
- Profit aggression.
- Growth stairs mode.
- Blind sniper availability.
- Guide/strict filters.
- Match-sniper cooldown and cold-count tolerance.

When Auto changes volatility symbol, the bot resubscribes the live tick stream and rebuilds the digit window before allowing the next trade. This prevents the bot from analyzing one volatility index while buying contracts on another.

Auto states:

- Scout: gather early evidence and keep risk low.
- Grind: use the base strategy to build profit fuel.
- Pressure: spend earned profit fuel on high-risk Over 7 / Under 2.
- Blast: demo/aggressive-only state that can use Digit Match Sniper.
- Recovery: lock high-risk weapons while recovery debt is open.
- Defense: lock high-risk weapons when win rate, drawdown, or loss streak is weak.
- Finish: protect the run near target and avoid late oversized shots.

Profit fuel is the key rule. Auto only unlocks high-risk/high-reward modes when session equity is above both the seed and the protected floor by enough margin for the selected risk profile.

## Phase Logic

Growth mode:

- Base stake is 2 percent of session balance.
- Minimum stake is `$0.35`.
- The bot tracks a protected realized-profit floor.
- Growth stairs are optional and can run in either profit mode or loss-pressure mode.
- Profit stairs: each mini milestone above the current growth anchor bumps the growth floor by a fixed percentage of the minimum stake.
- Loss-pressure stairs: ordinary growth/profit-push losses increase a capped temporary tier, while ordinary wins lower the tier and reset it after the configured win count.
- Loss-pressure stairs can carry only small recovery debt. If the debt exceeds the configured cap or the tier limit is reached, normal martingale/split recovery takes over.
- When session balance reaches the protected floor plus the profit gate step, the bot enters Risky Jump.
- On standard goals, the gate step defaults to 8 percent of the seed, or at least two minimum stakes, whichever is higher.
- On compact goals, the gate step is capped from the actual seed-to-target gap, so a `$100 -> $105` run no longer waits for an `$8` profit wave before using stronger closeout logic.
- Every winning trade can push the protected floor higher.

Profit push:

- Only runs in compact-target mode, only while no recovery debt is open.
- Arms after the configured profit-progress threshold, which moves earlier as profit aggression is increased.
- Sizes stake from the remaining target gap and the observed digit-contract win payout ratio, then caps exposure as a fraction of session equity.
- Pauses automatically when the confidence gate is active, recovery is open, or split recovery is armed.

Risky Jump:

- One stake at 35 percent of current session balance.
- Win: lock the new floor and return to Growth mode.
- Loss: enter recovery mode, where the next stake is sized from the realized loss and capped so it cannot consume the full session balance.

Martingale:

- Recovery stakes are calculated from the amount needed to get back to the protected floor, plus a small buffer.
- The recovery stake is always capped at 40 percent of the remaining session balance.
- Win: return to Growth mode once the protected floor is regained.
- Loss: stay in recovery until the floor is regained, or enter Rebuild mode if the balance becomes too small.
- When a martingale recovery win clears the debt, the growth staircase resets back to its default floor before climbing again.

Rebuild:

- Stake `$0.35`.
- Trade until the session balance reaches the original seed, then restart Growth mode.
- Stop if session balance drops below 50 percent of seed while in Rebuild mode.

Blind sniper overlay:

- Disabled by default.
- Ignores the extra guide filters.
- Arms at the configured progress marks. Defaults are `25, 50, 75`.
- Use negative marks such as `-50, -25` if you want snipes to reset and re-arm while climbing back from below seed.
- Fires after the configured completed-trade cadence, regardless of win or loss.
- Starts from one-third of session balance, then applies gap/profit caps so compact targets do not risk a huge shot for a small remaining profit.
- Stops arming after all configured marks have been used. Add more marks if you want more than 3 possible shots.

Emergency recovery shot:

- If the last completed trades stack into the configured loss streak, the bot can fire one emergency recovery shot before returning to the normal recovery ledger.
- It is disabled in high-risk digit modes such as Over 7 / Under 2 and Digit Match Sniper. Those modes already have lottery-like variance, so recovery falls back to staged debt logic instead.
- The shot is debt-sized and capped by session balance, target gap, and `ALL_IN_STAKE_PERCENT`; it no longer defaults to staking nearly the whole session.
- Defaults are `ALL_IN_LOSS_STREAK_THRESHOLD=3` and `ALL_IN_STAKE_PERCENT=0.25`.

Exit:

- Take profit: session balance is greater than or equal to target.
- Stop loss: session balance drops below seed x 0.5 while in Rebuild mode.
- Manual stop from the dashboard.

Growth staircase defaults:

- `GROWTH_MILESTONE_PERCENT=0.025`
- `GROWTH_STAKE_BUMP_PERCENT=0.15`
- `GROWTH_STAKE_CAP_PERCENT=0.12`
- `GROWTH_STAIR_MODE=off`
- `LOSS_STAIR_MAX_TIER=3`
- `LOSS_STAIR_WIN_RESET_COUNT=2`
- `LOSS_STAIR_DEBT_CAP_PERCENT=0.18`

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
MONGODB_URL=
MONGODB_DB=deriv_digit_bot
DEFAULT_MODE=demo
SYMBOL=R_100
CURRENCY=USD
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=change-this-before-deploying
MIN_STAKE=0.35
BASE_STAKE_PERCENT=0.02
RISKY_STAKE_PERCENT=0.35
MARTINGALE_CAP_PERCENT=0.40
GROWTH_MILESTONE_PERCENT=0.025
GROWTH_STAKE_BUMP_PERCENT=0.15
GROWTH_STAKE_CAP_PERCENT=0.12
GROWTH_STAIR_MODE=off
LOSS_STAIR_MAX_TIER=3
LOSS_STAIR_WIN_RESET_COUNT=2
LOSS_STAIR_DEBT_CAP_PERCENT=0.18
PROFIT_GATE_PERCENT=0.08
PROFIT_AGGRESSION=2
AUTO_MODE_ENABLED=false
AUTO_CYCLE_MODE=true
AUTO_CYCLE_PROFIT=
AUTO_CYCLE_STAKE=
AUTO_CYCLE_PARTIAL_EXIT_TRADE_THRESHOLD=60
AUTO_CYCLE_PARTIAL_EXIT_PROFIT_RATIO=0.5
AUTO_CYCLE_RECYCLE_TRADE_THRESHOLD=100
AUTO_CYCLE_COOLDOWN_SECONDS=60
AUTO_RISK_PROFILE=balanced
AUTO_REVIEW_INTERVAL_TRADES=5
TARGET_SIZING_MODE=phased
DIGIT_STRATEGY_MODE=base
INVERT_DIGIT_SIGNAL=false
MATCH_SNIPER_COOLDOWN_TRADES=3
MATCH_SNIPER_MAX_COUNT=1
RECOVERY_BUFFER_PERCENT=0.05
ALL_IN_LOSS_STREAK_THRESHOLD=3
ALL_IN_STAKE_PERCENT=0.25
BLIND_SNIPER_ENABLED=false
BLIND_SNIPER_CADENCE_TRADES=3
BLIND_SNIPER_MAX_USES=3
BLIND_SNIPER_START_RATIO=0.75
BLIND_SNIPER_MILESTONES=25,50,75
BLIND_SNIPER_STAKE_FRACTION=0.3333333333
WINDOW_SIZE=20
GUIDE_FILTERS=false
STRICT_BAR_FILTERS=false
```

`DERIV_API_TOKEN` is the main token the bot uses. `DERIV_APP_ID` must be the App ID from a new PAT application you registered on `developers.deriv.com`; do not reuse the old legacy `1089` App ID. `DERIV_ACCOUNT_ID` is optional and only needed if you want to pin a specific account instead of letting the bot pick the first active demo or real account that matches the selected mode.

## Persistence

If `MONGODB_URL` is set, the app stores each run in MongoDB. Put the connection string in your local `.env` file, or set it as a Heroku / DigitalOcean environment variable:

```env
MONGODB_URL=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=deriv_digit_bot
```

With Mongo enabled:

- run summaries stay available after restarts and redeploys
- trade and phase events are saved for later review
- paused runs can be resumed without losing the session state
- interrupted runs are marked separately if the process died mid-trade
- the dashboard can show whether the latest session is still live, paused, or already ended
- the dashboard can show whether the last finished run stopped by take profit, stop loss, manual stop, or a server restart

If MongoDB is not configured, the dashboard still works, but run history stays in memory only.

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
heroku config:set MONGODB_URL=your_mongodb_connection_string
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

If you want run history and resume snapshots on the droplet, add `MONGODB_URL` and `MONGODB_DB` to `.env` before starting the app.

That script installs Node.js 24 LTS, PM2, and UFW, opens port 3000, installs dependencies, and starts the app. The `pm2 startup` command prints one more command. Copy and run that printed command if your server asks for it.

Open the dashboard at `http://YOUR_DROPLET_IP:3000`.

## Safer Live Use

- Use a demo account first.
- Keep `DASHBOARD_PASSWORD` set on any public server.
- Do not paste a live authorization token into a dashboard served over plain HTTP on an untrusted network.
- A bot can execute faster than manual clicking, but it does not remove the house edge or streak risk.
