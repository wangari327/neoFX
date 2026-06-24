param(
  [Parameter(Mandatory = $true)]
  [string]$DropletIp,

  [string]$SshUser = "root",

  [string]$IdentityFile = "",

  [string]$RemoteDir = "/opt/deriv-digit-bot",

  [string]$Port = "3000"
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$Archive = Join-Path $env:TEMP "deriv-digit-bot.tar.gz"
$RemoteArchive = "/tmp/deriv-digit-bot.tar.gz"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "ssh is not available in PATH."
}

if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw "scp is not available in PATH."
}

function Invoke-Ssh {
  param([string[]]$Args)
  if ($IdentityFile) {
    & ssh -i $IdentityFile @Args
  } else {
    & ssh @Args
  }
}

function Invoke-Scp {
  param([string[]]$Args)
  if ($IdentityFile) {
    & scp -i $IdentityFile @Args
  } else {
    & scp @Args
  }
}

Push-Location $ProjectDir
try {
  if (Test-Path $Archive) {
    Remove-Item $Archive -Force
  }

  tar --exclude=node_modules --exclude=.git --exclude=server.log --exclude=server.err.log -czf $Archive .

  Invoke-Scp @($Archive, "${SshUser}@${DropletIp}:$RemoteArchive")

  $remoteCommand = "set -e; mkdir -p '$RemoteDir'; rm -rf '$RemoteDir'/*; tar -xzf '$RemoteArchive' -C '$RemoteDir'; rm -f '$RemoteArchive'; chmod +x '$RemoteDir/scripts/provision-vps.sh'; PORT=$Port bash '$RemoteDir/scripts/provision-vps.sh' '$RemoteDir'"

  Invoke-Ssh @("$SshUser@$DropletIp", $remoteCommand)
}
finally {
  Pop-Location
  if (Test-Path $Archive) {
    Remove-Item $Archive -Force
  }
}

Write-Host "Deployment finished. Open http://$DropletIp`:$Port in your browser."
